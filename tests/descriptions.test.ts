import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProjectSynchronizer } from '../src/project-sync.js';
import { MilestoneSynchronizer } from '../src/milestone-sync.js';
import { SdkLinearWorkspace } from '../src/sdk-adapter.js';
import { SyncState } from '../src/state.js';
import { loadConfig } from '../src/config.js';

test('long project descriptions sync both ways with pre-content snapshots', async () => {
 const config = await loadConfig('config.toml');
 const state = new SyncState(':memory:');
 try {
 const personal:any = {id:'p',url:'p',workspaceKey:'personal',name:'Project',description:'Summary',content:null,statusName:'Planned',statusType:'planned',priority:0,startDate:null,targetDate:null,leadAssigned:false,memberAssigned:false,archived:false,labelNames:['sync:sentry'],updatedAt:'2026-11-01',externalLinks:[{workspaceKey:'sentry',projectId:'e',projectUrl:'e'}],resources:[]};
 const external:any = {...personal,id:'e',url:'e',workspaceKey:'sentry',content:'Full project description'};
 const baseline = {...personal};delete baseline.content;
 state.upsertProjectMapping({personalProjectId:'p',externalWorkspaceKey:'sentry',externalProjectId:'e',personalProjectUrl:'p',externalProjectUrl:'e',active:true,conflict:false,broken:false});
 state.putProjectSnapshot(baseline,'sentry');
 const client:any = {addProjectLabel:async()=>{},listProjectMilestones:async()=>[],listProjectStatuses:async()=>[{name:'Planned',type:'planned'}],updateProject:async(id:string,update:any)=>Object.assign(id==='p'?personal:external,update),removeProjectLabel:async()=>{}};
 const sync:any = new ProjectSynchronizer(config,client,new Map([['sentry',client]]),state);
 const pair={externalConfig:config.external.find(x=>x.key==='sentry'),external:client};
 await sync.processMapping(personal,pair,external,false,new Set());
 assert.equal(personal.content,'Full project description');
 personal.content='Revised description';
 await sync.processMapping(personal,pair,external,false,new Set());
 assert.equal(external.content,'Revised description');
 assert.equal(sync.toCreateInput(personal).content,'Revised description');
 personal.content=null;
 await sync.processMapping(personal,pair,external,false,new Set());
 assert.equal(external.content,null);
 } finally {state.close();}
});

test('milestone descriptions sync both ways and can be cleared', async()=>{
 const state=new SyncState(':memory:');
 try {
 const personal:any={id:'m',projectId:'p',workspaceKey:'personal',name:'Milestone',description:'',targetDate:null,sortOrder:0,archived:false,updatedAt:'2026-11-01'};
 const external:any={...personal,id:'n',projectId:'e',workspaceKey:'sentry',description:null};
 const mapping:any={personalProjectId:'p',externalWorkspaceKey:'sentry',externalProjectId:'e',personalMilestoneId:'m',externalMilestoneId:'n',active:true,conflict:false,broken:false};
 state.upsertMilestoneMapping(mapping);
 state.putMilestoneSnapshot('m','sentry',{personal:{...personal},external:{...external}});
 const client:any={updateProjectMilestone:async(id:string,update:any)=>Object.assign(id==='m'?personal:external,update)};
 const sync:any=new MilestoneSynchronizer(client,state,{markConflict:async()=>assert.fail('unexpected conflict'),markBroken:async()=>assert.fail('unexpected broken state')});
 const pair:any={externalConfig:{key:'sentry'},external:client};
 personal.description='Detailed milestone';
 await sync.syncMappedMilestone(personal,external,mapping,pair,{});
 assert.equal(external.description,'Detailed milestone');
 external.description='Remote revision';
 await sync.syncMappedMilestone(personal,external,mapping,pair,{});
 assert.equal(personal.description,'Remote revision');
 personal.description=null;
 await sync.syncMappedMilestone(personal,external,mapping,pair,{});
 assert.equal(external.description,null);
 } finally {state.close();}
});

test('expired notification credentials fall back to personal API client',async()=>{
 const adapter:any=Object.create(SdkLinearWorkspace.prototype);
 adapter.config={name:'personal'};adapter.viewerUrl='viewer';
 let calls=0;
 adapter.notificationClient={createComment:async()=>{throw new Error('Authentication required, not authenticated');}};
 adapter.client={createComment:async()=>{calls++;return {success:true};}};
 await adapter.addPersonalNotification('p','Conflict');
 assert.equal(calls,1);
 adapter.notificationClient={createComment:async()=>{throw new Error('Rate limit exceeded');}};
 await assert.rejects(adapter.addPersonalNotification('p','Conflict'),/Rate limit/);
 assert.equal(calls,1);
 adapter.notificationClient={createComment:async()=>({success:false})};
 await assert.rejects(adapter.addPersonalNotification('p','Conflict'),/failed to create notification/);
});
