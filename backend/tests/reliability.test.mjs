import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// No real database, mail server, credentials, or student data are used.
let query = async () => ({ rows: [], rowCount: 0 });
mock.module('../src/db.ts', { exports: { db: { query: (...args) => query(...args) } } });
const { noteWatcher, noteSyncSuccess, noteEvent, getSystemStatus } = await import('../src/systemStatus.ts');
const { fetchThreadSummaries } = await import('../src/thread.ts');

test('repeated reconnect failures preserve the original outage age', async t => {
    const now=Date.now();
    t.mock.timers.enable({apis:['Date'],now});
    query=async()=>({rows:[]});
    noteWatcher('outage@example.test',false);
    for(let i=1;i<=26;i++) { t.mock.timers.setTime(now+i*5000); noteWatcher('outage@example.test',false); noteSyncSuccess('outage@example.test'); }
    assert.ok((await getSystemStatus()).warnings.some(w=>w.includes('outage@example.test')));
    noteWatcher('outage@example.test',true);
    assert.ok(!(await getSystemStatus()).warnings.some(w=>w.includes('outage@example.test')));
    noteWatcher('outage@example.test',false);
    assert.ok(!(await getSystemStatus()).warnings.some(w=>w.includes('outage@example.test')),'a new outage starts a fresh timer');
});

test('activity counts expose their retention limits instead of claiming full-day coverage', async () => {
    query=async()=>({rows:[]});
    for(let i=0;i<510;i++) noteEvent('recovered',`synthetic ${i}`,'hot');
    const status=await getSystemStatus();
    assert.equal(status.activityCoverage.approximate,true);
    assert.equal(status.activityCoverage.maxEvents,500);
    assert.equal(status.activityCoverage.retainedEvents,500);
    assert.equal(status.recoveredToday.hot,500);
    assert.ok(Date.parse(status.activityCoverage.since)<=Date.parse(status.generatedAt));
});

test('once the event cap drops events, coverage starts at the oldest one kept', async t => {
    const now=Date.now()+60000;
    t.mock.timers.enable({apis:['Date'],now});
    query=async()=>({rows:[]});
    for(let i=0;i<510;i++) { t.mock.timers.setTime(now+i*1000); noteEvent('retry',`capped ${i}`); }
    const status=await getSystemStatus();
    assert.equal(status.activityCoverage.since,new Date(now+10*1000).toISOString());
});

test('a later rejection linked to registration stays in the Rejected filter', async () => {
    const base={student_email:'student@example.test',sender_email:'notify@edu.gov.kg',subject:'Edugate',body_text:'',body_html:null,replied:false,replied_at:null,handled_without_reply:false,student_registered_at:'2026-09-26T10:00:00Z',in_reply_to:null,reference_ids:[]};
    const login={...base,id:1,message_id:'<login>',edugate_kind:'login',received_at:'2026-09-26T10:00:00Z',sent_at:'2026-09-26T10:00:00Z'};
    const rejected={...base,id:2,message_id:'<rejected>',in_reply_to:'<login>',reference_ids:['<login>'],edugate_kind:'rejected',received_at:'2026-09-26T14:00:00Z',sent_at:'2026-09-26T14:00:00Z'};
    query=async sql=>({rows:sql.includes('FROM messages')?[login,rejected]:[]});
    const page=await fetchThreadSummaries('all','staff@example.test','1',25,0,undefined,'rejected');
    assert.equal(page.threads.length,1);
    assert.equal(page.threads[0].badge,'rejected');
    assert.equal(page.threads[0].registered,true,'account registration remains separate from document approval');
    login.sent_at='2026-09-26T15:00:00Z'; login.received_at=login.sent_at;
    const newerLogin=await fetchThreadSummaries('all','staff@example.test','1',25,0,undefined,'registered');
    assert.equal(newerLogin.threads.length,1,'a genuinely newer registration can become the latest event');
});

test('thread list rows carry the student application number', async () => {
    const msg={id:1,message_id:'<q>',student_email:'Student@example.test',sender_email:'student@example.test',subject:'Question',body_text:'hi',body_html:null,replied:false,replied_at:null,handled_without_reply:false,student_registered_at:null,in_reply_to:null,reference_ids:[],edugate_kind:null,received_at:'2026-09-26T10:00:00Z',sent_at:'2026-09-26T10:00:00Z'};
    query=async sql=>({rows:sql.includes('AS app_no')?[{email:'student@example.test',name:'Jane Doe',app_no:'10012345'}]:sql.includes('FROM messages')?[msg]:[]});
    const page=await fetchThreadSummaries('all','staff@example.test','1',25,0);
    assert.equal(page.threads[0].student_name,'Jane Doe');
    assert.equal(page.threads[0].student_app_no,'10012345');
});
