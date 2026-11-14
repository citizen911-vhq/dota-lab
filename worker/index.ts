import handler from "vinext/server/fetch-handler";
import { runWithConnectorBinding } from "../lib/connector-context";
import type { ConnectorBinding } from "../lib/connector-contract.mjs";
import { runPrematchRefresh } from "../lib/dota-auto-store";
import { technicalFailure } from "../lib/dota-technical-core";
import { recordTechnicalError } from "../lib/dota-technical-log";

const worker = {
  scheduled(_event: ScheduledController, _env: Cloudflare.Env, ctx: ExecutionContext) {
    ctx.waitUntil(runPrematchRefresh().catch(async error => {
      const failure = technicalFailure(error, '/internal/scheduled/prematch-refresh');
      if (failure) await recordTechnicalError({ ...failure, code: 'SCHEDULED_REFRESH_FAILED' });
      throw error;
    }));
  },
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext<{ CONNECTORS?: ConnectorBinding }>) {
    let binding = ctx.props?.CONNECTORS;
    // Local preview emulates the same request-scoped capability. This branch and
    // the auxiliary service binding are absent from production builds.
    if (import.meta.env.DEV && !binding && env.CONNECTORS) {
      const preview = env.CONNECTORS;
      const expiresAt = Date.now() + 60_000;
      binding = {
        async getContext() {
          if (Date.now() >= expiresAt) return { status: "request_context_expired" };
          return preview.getContext?.() ?? { status: "binding_unavailable" };
        },
        async invoke(connectorId, actionName, args) {
          if (Date.now() >= expiresAt) {
            return { status: "request_context_expired", message: "This request has expired. Please try again." };
          }
          return preview.invoke(connectorId, actionName, args);
        },
      };
    }
    try {
      return await runWithConnectorBinding(binding, () => handler.fetch(request, env, ctx));
    } catch (error) {
      // Responses returned by fail() are already recorded; only uncaught throws arrive here.
      const failure = technicalFailure(error, new URL(request.url).pathname);
      if (failure) await recordTechnicalError({ ...failure, code: 'WORKER_FETCH_FAILED' });
      throw error;
    }
  },
};

export default worker;
