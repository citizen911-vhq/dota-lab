"use client";

import { useEffect } from 'react';
import { captureRenderError } from '@/components/dota/technical-error-capture';

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { captureRenderError(error); }, [error]);
  return <main className="technical-fallback" role="alert">
    <h1>Не удалось отобразить Dota Lab</h1>
    <p>Произошла техническая ошибка. Приложение попробует сохранить её в отдельный журнал; ИИ автоматически не запускается.</p>
    <button className="button button-primary" onClick={reset}>Попробовать снова</button>
  </main>;
}
