const test = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/ai');

function invoke(method, body) {
  const req = {method, body, headers:{'x-forwarded-for':'unit-test-'+Math.random()}};
  const res = {setHeader(){}, status(code){this.code=code;return this;}, json(data){this.data=data;return this;}};
  return handler(req,res).then(()=>res);
}

test('GET reports missing configuration without exposing a key', async () => {
  delete process.env.GEMINI_API_KEY;
  const res = await invoke('GET');
  assert.equal(res.data.ok,false);
});

test('Gemini receives a native generateContent request with key only in server header', async () => {
  process.env.GEMINI_API_KEY = 'test-server-key';
  const oldFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.match(url,/\/models\/gemini-2\.5-flash:generateContent$/);
    assert.equal(options.headers['x-goog-api-key'],'test-server-key');
    assert.ok(!options.body.includes('test-server-key'));
    const data=JSON.parse(options.body);
    assert.equal(data.contents[0].parts[0].text,'Explain derivatives');
    return {ok:true, json:async()=>({candidates:[{content:{parts:[{text:'Start with the slope.'}]}}]})};
  };
  try {
    const res=await invoke('POST',{messages:[{role:'user',content:'Explain derivatives'}]});
    assert.equal(res.code,200);
    assert.equal(res.data.text,'Start with the slope.');
  } finally {global.fetch=oldFetch;delete process.env.GEMINI_API_KEY;}
});

test('Provider permission failure maps to actionable error', async () => {
  process.env.GEMINI_API_KEY='invalid';
  const oldFetch=global.fetch;
  global.fetch=async()=>({ok:false,status:403,json:async()=>({error:{message:'denied'}})});
  try {
    const res=await invoke('POST',{messages:[{role:'user',content:'hello'}]});
    assert.equal(res.code,502);
    assert.equal(res.data.error,'invalid_key_or_permissions');
  } finally {global.fetch=oldFetch;delete process.env.GEMINI_API_KEY;}
});

test('Rejects invalid chat payload before provider call', async () => {
  process.env.GEMINI_API_KEY='test';
  try {
    const res=await invoke('POST',{messages:[{role:'assistant',content:'hello'}]});
    assert.equal(res.code,400);
  } finally {delete process.env.GEMINI_API_KEY;}
});
