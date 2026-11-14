import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
registerHooks({resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/.test(s))return n(s+'.ts',c);throw e;}}});
const {redactTechnicalText,technicalRoute,normalizeTechnicalInput,technicalFailure,browserTechnicalInputs}=await import('../lib/dota-technical-core.ts');
const {DataError}=await import('../lib/dota-core.ts');

test('technical log scrubs credentials, URLs, private paths, tokens and connection strings',()=>{
 const source=`Error password=hunter2 api_key='abc_def' {"OPENAI_API_KEY":"inside-json", "access_token":"json-token"}
Authorization: Bearer super-secret-value
Cookie: a=cookie-one;b=cookie-two
Bearer standalone-token Basic basic-encoded
postgres://db-user:db-pass@private-db:5432/db?ssl=true mongodb+srv://usr:pw@cluster/db
https://url-user:url-password@example.com/api?api_key=query-secret&other=also-secret#token-fragment
at /Users/alice/private/repo/server.ts:15:2 C:\\Users\\bob\\work\\app.js:3 /home/charlie/project/a.ts
file:///Users/alice/private/file.ts:9 /var/folders/ab/private-file
sk-proj-testSecret12345678 ghp_privateToken12345678 eyJhbGciOiJIUzI1NiJ9.payload.signature
-----BEGIN PRIVATE KEY-----\nprivate-key-material\n-----END PRIVATE KEY-----
`;
 const result=redactTechnicalText(source);
 for(const secret of ['hunter2','abc_def','inside-json','json-token','super-secret-value','cookie-one','cookie-two','standalone-token','basic-encoded','db-user','db-pass','private-db','cluster','url-user','url-password','query-secret','also-secret','token-fragment','alice','bob','charlie','private-file','testSecret','privateToken','eyJ','private-key-material'])assert.ok(!result.includes(secret),secret+' must be removed');
 assert.ok(result.includes('example.com/api'));assert.ok(result.includes('[private-path]'));
});
test('redaction removes explicit configured secrets even without a recognizable prefix',()=>{
 const result=redactTechnicalText('Error plainKnownSecret and url/path/a%2Fb%3Fkey',6000,['plainKnownSecret','a/b?key']);
 assert.ok(!result.includes('plainKnownSecret'));assert.ok(!result.includes('a%2Fb%3Fkey'));
 assert.ok(!redactTechnicalText('trimmed-key',6000,['  trimmed-key  ']).includes('trimmed-key'));
 assert.ok(!redactTechnicalText('bad short key: xyz',6000,['xyz']).includes('xyz'));
 assert.equal(redactTechnicalText({env:{secret:'nope'}}),'');
 assert.equal(redactTechnicalText('a'.repeat(9000),20),'a'.repeat(20));
});
test('technical route never includes origin, queries, credentials or fragments',()=>{
 assert.equal(technicalRoute('https://user:pass@example.com/api/ai?token=secret#private'),'/api/ai');
 assert.equal(technicalRoute('/api/journal?a=1'),'/api/journal');
 assert.equal(technicalRoute('javascript:alert(1)'),null);
 assert.ok(!technicalRoute('/Users/alice/private').includes('alice'));
 const clean=normalizeTechnicalInput({source:'provider',code:'FETCH_ERROR',message:'failed',route:'/api/plainKnownSecret'},['plainKnownSecret']);
 assert.ok(!clean.route.includes('plainKnownSecret'));
});
test('expected business/auth/validation conflicts are not technical incidents',()=>{
 for(const status of [400,401,403,404,409,413,415,429])assert.equal(technicalFailure(new DataError('Expected',status)),null);
 assert.equal(technicalFailure(new DataError('Storage down',503)).code,'HTTP_503');
 const failure=technicalFailure(new Error('Unexpected'),'/api/ai');assert.equal(failure.source,'server');assert.equal(failure.route,'/api/ai');assert.ok(failure.details.includes('Unexpected'));
});
test('browser capture enforces bounded input and server-owned provenance',()=>{
 for(const input of [null,[],{}, {events:[]},{events:Array.from({length:11},()=>({code:'x',message:'x'}))},{events:[{code:'x',message:'x'.repeat(1001)}]},{events:[{code:'x',message:'ok',details:{secret:'x'}}]},{events:[{code:'x',message:'ok',severity:'fatal'}]}])assert.throws(()=>browserTechnicalInputs(input),DataError);
 const result=browserTechnicalInputs({events:[{source:'server',project:'other-project',id:'attacker-id',count:100,first_seen:'1900',code:'browser.runtime',message:'failed',route:'/api?token=x'}]});
 assert.equal(result[0].source,'browser');for(const key of ['project','id','count','first_seen'])assert.ok(!(key in result[0]));
});
