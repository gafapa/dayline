import assert from 'node:assert/strict';
export async function postFixture(client,url,headers,data){
 for(let attempt=0;attempt<3;attempt++){
  const response=await client.post(url,{headers,data});
  if(response.status()!==429){assert.equal(response.status(),200,await response.text());return response.json();}
  const seconds=Number(response.headers()['retry-after']);
  assert.ok(Number.isInteger(seconds)&&seconds>0&&seconds<=900,'Fixture quota retry deadline unavailable');
  if(attempt===2)throw new Error('Fixture quota remained unavailable after bounded retries');
  const deadline=Date.now()+seconds*1000;
  console.info(`Waiting ${seconds}s for the unchanged fixture-account request quota.`);
  while(Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,Math.min(30000,deadline-Date.now())));
 }
}
