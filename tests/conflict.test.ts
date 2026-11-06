import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ReconciliationEngine } from '../src/reconcile.js';
import { SyncState } from '../src/state.js';
import { loadConfig } from '../src/config.js';

async function fixture() {
 const config = await loadConfig('config.toml');
 const state = new SyncState(':memory:');
 const base: any = {id:'p', identifier:'TIN-542',url:'p',workspaceKey:'personal',title:'Task',description:'base',statusName:'Todo',dueDate:null,estimate:null,priority:0,assigneeEmail:null,archived:false,labelNames:[],projectId:null,projectMilestoneId:null,resources:[],updatedAt:'2026-11-01',externalLinks:[]};
 const personal = {...base,description:'personal draft',labelNames:['sync:conflict']};
 const external = {...base,id:'e',workspaceKey:'sentry',description:'remote edit'};
 const mapping = {personalIssueId:'p',externalWorkspaceKey:'sentry',externalIssueId:'e',personalIssueUrl:'p',externalIssueUrl:'e',active:true,conflict:false,broken:false};
 state.upsertMapping(mapping);state.putSnapshot(base,'sentry');
 const client: any = {viewerEmail:'me',addLabel:async()=>{},removeLabel:async()=>{},addPersonalNotification:async()=>{},listStatusNames:async()=>new Set(['Todo']),updateIssue:async(id:string,update:any)=>Object.assign(id==='p'?personal:external,update)};
 const engine:any = new ReconciliationEngine(config,client,new Map([['sentry',client]]),state);
 const pair = {externalConfig:config.external.find(x=>x.key==='sentry'),external:client};
 return {state,personal,external,client,engine,pair};
}
test('removing a recorded conflict label selects personal values and stays resolved',async()=>{
 const f=await fixture();try {
 await f.engine.processMapping(f.personal,f.pair,f.external,false,new Set());
 f.personal.labelNames=[];
 await f.engine.processMapping(f.personal,f.pair,f.external,false,new Set());
 assert.equal(f.external.description,'personal draft');
 assert.equal(f.state.getMapping('p','sentry')?.conflict,false);
 await f.engine.processMapping(f.personal,f.pair,f.external,false,new Set());
 assert.equal(f.personal.labelNames.includes("sync:conflict"),false);
 } finally {f.state.close();}
});
test('failed notification is retried on the next pass',async()=>{
 const f=await fixture();try {
 let attempts=0;f.client.addPersonalNotification=async()=>{if(++attempts===1)throw new Error('notification unavailable');};
 await assert.rejects(f.engine.processMapping(f.personal,f.pair,f.external,false,new Set()));
 await f.engine.processMapping(f.personal,f.pair,f.external,false,new Set());
 assert.equal(attempts,2);
 } finally {f.state.close();}
});
test('an empty remote description is not a concurrent edit of an empty baseline',async()=>{
 const f=await fixture();try {
 const previous=f.state.getSnapshot('p','sentry')!;previous.description='';f.state.putSnapshot(previous,'sentry');
 f.external.description=null;f.personal.labelNames=[];
 await f.engine.processMapping(f.personal,f.pair,f.external,false,new Set());
 assert.equal(f.external.description,'personal draft');assert.equal(f.state.getMapping('p','sentry')?.conflict,false);
 } finally {f.state.close();}
});
test('a new genuine conflict pauses even when no label was present',async()=>{
 const f=await fixture();try {
 f.personal.labelNames=[];
 const result=await f.engine.processMapping(f.personal,f.pair,f.external,false,new Set());
 assert.equal(result.conflicts,1);
 assert.equal(f.external.description,'remote edit');
 assert.equal(f.personal.labelNames.includes('sync:conflict'),true);
 } finally {f.state.close();}
});
test('a failed personal overwrite retains the conflict for retry',async()=>{
 const f=await fixture();try {
 await f.engine.processMapping(f.personal,f.pair,f.external,false,new Set());
 f.personal.labelNames=[];
 const update=f.client.updateIssue;
 f.client.updateIssue=async()=>{throw new Error('remote unavailable');};
 await assert.rejects(f.engine.processMapping(f.personal,f.pair,f.external,false,new Set()),/remote unavailable/);
 assert.equal(f.state.getMapping('p','sentry')?.conflict,true);
 f.client.updateIssue=update;
 await f.engine.processMapping(f.personal,f.pair,f.external,false,new Set());
 assert.equal(f.external.description,'personal draft');
 assert.equal(f.state.getMapping('p','sentry')?.conflict,false);
 } finally {f.state.close();}
});
