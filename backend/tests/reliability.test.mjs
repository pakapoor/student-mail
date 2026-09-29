import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

// No real database, mail server, credentials, or student data are used.
let query = async () => ({ rows: [], rowCount: 0 });
let connect = async () => { throw new Error('Unexpected connection'); };
mock.module('../src/db.ts', { exports: { db: { query: (...args) => query(...args), connect: () => connect() } } });
let setupImap = () => {};
const clients = [];
class FakeImap extends EventEmitter {
    mailbox = { uidValidity: 1n, exists: 1 };
    closed = false;
    connect = async () => {};
    getMailboxLock = async () => ({ release() {} });
    fetch = async function* () {};
    search = async () => [];
    close() { this.closed = true; this.emit('close'); }
    constructor() { super(); clients.push(this); setupImap(this); }
}
mock.module('imapflow', { exports: { ImapFlow: FakeImap } });
const broadcasts = [];
mock.module('../src/realtime.ts', { exports: { broadcast: (...args) => broadcasts.push(args), addClient() {}, removeClient() {} } });
const { insertMessageForStudent, syncInbox } = await import('../src/sync.ts');
const { withSyncDeadline } = await import('../src/syncDeadline.ts');
const { noteWatcher, noteSyncSuccess, noteEvent, getSystemStatus } = await import('../src/systemStatus.ts');
const { fetchThreadSummaries } = await import('../src/thread.ts');
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };

// A central mailbox at watermark UID 10 holding the given emails for one student.
const raw = n => Buffer.from(`Message-ID: <m${n}@example.test>\r\nFrom: sender@example.test\r\nTo: student@example.test\r\nSubject: Test ${n}\r\nDate: Sat, 26 Sep 2026 10:00:00 +0000\r\n\r\nBody ${n}\r\n`);
const mailboxWith = messages => {
    setupImap = client => {
        client.mailbox.exists = messages.length;
        client.fetch = async function* () { for (const m of messages) yield { internalDate: new Date(), ...m }; };
        client.search = async () => messages.map(m => m.uid).sort((a, b) => a - b);
    };
};
const mailboxQueries = watermarks => async (sql, params) => {
    if (sql.includes('SELECT email')) return { rows: [{ email: 'student@example.test' }] };
    if (sql.includes('SELECT last_uid')) return { rows: [{ last_uid: '10', uid_validity: '1' }] };
    if (sql.includes('UPDATE central_mailboxes')) watermarks.push(params[1]);
    if (sql.includes('college_id')) return { rows: [{ college_id: 7 }] };
    return { rows: [] };
};
// Every insert succeeds unless onInsert throws; onInsert sees the Message-ID.
const insertingConnection = onInsert => async () => ({
    async query(sql, params) {
        if (sql.includes('INSERT INTO messages')) { onInsert(params[0]); return { rowCount: 1, rows: [] }; }
        return { rows: [], rowCount: 0 };
    },
    release() {},
});

for (const kind of ['code', 'login']) {
    test(`${kind}: registration failure rolls back the message, retry commits both`, async () => {
        let stored = false, registered = false, fail = true, released = 0;
        const statements = [];
        connect = async () => {
            let stagedStored = stored, stagedRegistered = registered;
            return {
                async query(sql) {
                    statements.push(sql.trim().split(/\s+/)[0]);
                    if (sql.includes('INSERT INTO messages')) {
                        const inserted = !stagedStored; stagedStored = true;
                        return { rowCount: inserted ? 1 : 0, rows: [] };
                    }
                    if (sql.includes('UPDATE students')) {
                        if (fail) throw new Error('status write failed');
                        stagedRegistered = true;
                    }
                    if (sql === 'COMMIT') { stored = stagedStored; registered = stagedRegistered; }
                    return {rows:[],rowCount:0};
                },
                release() { released++; }
            };
        };
        const text = kind === 'code'
            ? 'Your verification code:\n\n123456\n\nEnter this code. The code is valid for 30 minutes.\n'
            : 'Login (Email):\nstudent@example.test Password:\nexample-password\n\n';
        const save = () => insertMessageForStudent({text}, '<test>', 'confirm@edu.gov.kg', 'student@example.test', new Date(), 'staff@example.test');
        await assert.rejects(save(), /status write failed/);
        assert.equal(stored,false); assert.equal(registered,false);
        assert.equal(statements.at(-1),'ROLLBACK');
        fail = false;
        assert.equal(await save(),true);
        assert.equal(stored,true); assert.equal(registered,true);
        assert.equal(await save(),false,'retries remain idempotent');
        assert.equal(released,3);
    });
}

test('deadline aborts work but waits for cleanup before settling', async t => {
    t.mock.timers.enable({apis:['setTimeout']});
    const cleanup = defer(), aborted = defer();
    let settled = false;
    const operation = withSyncDeadline(async signal => {
        await new Promise(resolve => signal.addEventListener('abort', () => { aborted.resolve(); resolve(); }, {once:true}));
        await cleanup.promise;
        signal.throwIfAborted();
    },45,'staff@example.test');
    const checked = assert.rejects(operation,/deadline/).then(() => { settled=true; });
    t.mock.timers.tick(46); await aborted.promise;
    assert.equal(settled,false,'caller must retain its running guard during cleanup');
    cleanup.resolve(); await checked;
});

test('a run that still finishes after the deadline keeps its result', async t => {
    t.mock.timers.enable({apis:['setTimeout']});
    const operation = withSyncDeadline(async signal => {
        await new Promise(resolve => signal.addEventListener('abort', resolve, {once:true}));
        return 'finished';
    },45,'staff@example.test');
    t.mock.timers.tick(46);
    assert.equal(await operation,'finished','completed work must not be reported as a failure');
});

test('a pass aborted part-way keeps its progress and reports what it stored', async () => {
    const controller = new AbortController(), watermarks = [];
    mailboxWith([{uid:11,source:raw(11)},{uid:12,source:raw(12)},{uid:13,source:raw(13)}]);
    query = mailboxQueries(watermarks);
    connect = insertingConnection(id => { if (id === '<m12@example.test>') controller.abort(new Error('deadline hit')); });
    const failure = await syncInbox('staff@example.test','fake',controller.signal).catch(e => e);
    assert.equal(failure.name,'SyncFailure');
    assert.match(failure.message,/deadline hit/,'reports the abort reason, not the closed connection');
    assert.equal(failure.partial.inserted,2);
    assert.deepEqual(failure.partial.insertedStudentEmails,['student@example.test']);
    assert.deepEqual(watermarks,[12],'next pass resumes after the last fully handled email');
    setupImap=()=>{};
});

test('out-of-order delivery never checkpoints past an email not yet handled', async () => {
    // Real servers can stream FETCH results out of UID order (seen on GoDaddy).
    const controller = new AbortController(), watermarks = [];
    mailboxWith([{uid:13,source:raw(13)},{uid:11,source:raw(11)},{uid:12,source:raw(12)}]);
    query = mailboxQueries(watermarks);
    connect = insertingConnection(id => { if (id === '<m11@example.test>') controller.abort(new Error('deadline hit')); });
    const failure = await syncInbox('staff@example.test','fake',controller.signal).catch(e => e);
    assert.equal(failure.partial.inserted,2);
    assert.deepEqual(watermarks,[11],'13 is done but 12 is not, so resume after 11');
    setupImap=()=>{};
});

test('a failed UID listing does not fail the pass', async () => {
    const watermarks = [];
    mailboxWith([{uid:11,source:raw(11)}]);
    setupImap = (setup => client => { setup(client); client.search = async () => { throw new Error('SEARCH not supported'); }; })(setupImap);
    query = mailboxQueries(watermarks);
    connect = insertingConnection(() => {});
    const result = await syncInbox('staff@example.test','fake');
    assert.equal(result.inserted,1);
    assert.deepEqual(watermarks,[11]);
    setupImap=()=>{};
});

test('a failed pass never moves the watermark past an email still to be retried', async () => {
    const watermarks = [];
    mailboxWith([{uid:11,source:undefined},{uid:12,source:raw(12)},{uid:13,source:raw(13)}]);
    query = mailboxQueries(watermarks);
    connect = insertingConnection(id => { if (id === '<m13@example.test>') throw new Error('insert failed'); });
    const failure = await syncInbox('staff@example.test','fake').catch(e => e);
    assert.match(failure.message,/insert failed/);
    assert.equal(failure.partial.inserted,1);
    assert.deepEqual(watermarks,[],'UID 11 came back empty, so the watermark stays at 10');
    setupImap=()=>{};
});

test('emails stored before a sync failure are still announced', async () => {
    const { triggerSync } = await import('../src/mailboxSync.ts');
    const watermarks = [];
    broadcasts.length = 0;
    mailboxWith([{uid:11,source:raw(11)},{uid:12,source:raw(12)}]);
    query = mailboxQueries(watermarks);
    connect = insertingConnection(id => { if (id === '<m12@example.test>') throw new Error('insert failed'); });
    await triggerSync('partial@example.test','fake');
    assert.deepEqual(broadcasts,[['update',{reason:'new-mail',inserted:1,collegeIds:['7']},'partial@example.test']]);
    assert.deepEqual(watermarks,[11]);
    setupImap=()=>{};
});

test('abort closes IMAP and blocks watermark writes after a delayed database read', async () => {
    const gate=defer(), started=defer(); let watermarkWrites=0;
    setupImap=()=>{};
    query=async sql=>{
        if(sql.includes('SELECT email')) {started.resolve(); await gate.promise; return {rows:[]};}
        if(sql.includes('UPDATE central_mailboxes')) watermarkWrites++;
        return {rows:[]};
    };
    const controller=new AbortController();
    const run=syncInbox('staff@example.test','fake',controller.signal);
    const checked=assert.rejects(run,/cancelled/);
    await started.promise; controller.abort(new Error('cancelled'));
    assert.equal(clients.at(-1).closed,true);
    gate.resolve(); await checked;
    assert.equal(watermarkWrites,0);
});

test('connection failures close the IMAP client', async () => {
    setupImap=client=>{client.connect=async()=>{throw new Error('connect failed');};};
    await assert.rejects(syncInbox('staff@example.test','fake'),/connect failed/);
    assert.equal(clients.at(-1).closed,true);
    setupImap=()=>{};
});

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

test('deadline clears its timer on normal completion and operation errors', async t => {
    t.mock.timers.enable({apis:['setTimeout']});
    let saved;
    assert.equal(await withSyncDeadline(async signal=>{saved=signal; return 42;},45,'test'),42);
    t.mock.timers.tick(100); assert.equal(saved.aborted,false);
    const failure=new Error('original error');
    await assert.rejects(withSyncDeadline(async signal=>{saved=signal; throw failure;},45,'test'),e=>e===failure);
    t.mock.timers.tick(100); assert.equal(saved.aborted,false);
});

test('an in-flight watermark write settles before an aborted run can release its guard', async () => {
    const entered=defer(), finish=defer(); let settled=false;
    setupImap=client=>{client.mailbox.exists=0;};
    query=async sql=>{
        if(sql.includes('UPDATE central_mailboxes')) {entered.resolve(); await finish.promise;}
        return {rows:[]};
    };
    const controller=new AbortController();
    const run=syncInbox('staff@example.test','fake',controller.signal).finally(()=>{settled=true;});
    await entered.promise;
    controller.abort(new Error('cancelled'));
    await Promise.resolve();
    assert.equal(clients.at(-1).closed,true);
    assert.equal(settled,false,'the operation remains pending while the SQL write can still finish');
    finish.resolve(); await run;
    setupImap=()=>{};
});

test('rollback failure discards the connection without hiding the original failure', async () => {
    let discarded=false;
    connect=async()=>({
        async query(sql) {
            if(sql==='BEGIN') return {rows:[]};
            if(sql==='ROLLBACK') throw new Error('connection lost');
            throw new Error('insert failed');
        },
        release(discard) {discarded=discard;}
    });
    await assert.rejects(insertMessageForStudent({text:'hello'},'<failure>','sender@example.test','student@example.test',new Date(),'staff@example.test'),/insert failed/);
    assert.equal(discarded,true);
});

test('queued sync cannot start while the timed-out predecessor is still settling', async t => {
    const { triggerSync } = await import('../src/mailboxSync.ts');
    t.mock.timers.enable({apis:['setTimeout']});
    const readStarted=defer(), releaseRead=defer(), nextWrite=defer();
    let reads=0;
    const before=clients.length;
    setupImap=client=>{client.mailbox.exists=0;};
    query=async sql=>{
        if(sql.includes('SELECT email') && ++reads===1) {readStarted.resolve(); await releaseRead.promise;}
        if(sql.includes('UPDATE central_mailboxes')) nextWrite.resolve();
        return {rows:[]};
    };
    const first=triggerSync('serialized@example.test','fake');
    await readStarted.promise;
    await triggerSync('serialized@example.test','fake');
    t.mock.timers.tick(45001);
    assert.equal(clients.length,before+1,'no successor until old DB work settles');
    assert.equal(clients.at(-1).closed,true);
    releaseRead.resolve(); await first; await nextWrite.promise;
    await new Promise(setImmediate);
    assert.equal(clients.length,before+2,'queued successor starts after cleanup');
    assert.equal(clients.at(-1).closed,true);
    setupImap=()=>{};
});

test('thread list rows carry the student application number', async () => {
    const msg={id:1,message_id:'<q>',student_email:'Student@example.test',sender_email:'student@example.test',subject:'Question',body_text:'hi',body_html:null,replied:false,replied_at:null,handled_without_reply:false,student_registered_at:null,in_reply_to:null,reference_ids:[],edugate_kind:null,received_at:'2026-09-26T10:00:00Z',sent_at:'2026-09-26T10:00:00Z'};
    query=async sql=>({rows:sql.includes('AS app_no')?[{email:'student@example.test',name:'Jane Doe',app_no:'10012345'}]:sql.includes('FROM messages')?[msg]:[]});
    const page=await fetchThreadSummaries('all','staff@example.test','1',25,0);
    assert.equal(page.threads[0].student_name,'Jane Doe');
    assert.equal(page.threads[0].student_app_no,'10012345');
});

test('a student with several code emails shows one code row: the newest', async () => {
    const code=(id,email,at,extra={})=>({id,message_id:`<c${id}>`,student_email:email,sender_email:'confirm@edu.gov.kg',subject:'Edugate',body_text:'',body_html:null,replied:false,replied_at:null,handled_without_reply:false,student_registered_at:null,in_reply_to:null,reference_ids:[],edugate_kind:'code',received_at:at,sent_at:at,...extra});
    const older=code(1,'a@example.test','2026-09-26T10:29:02Z');
    const newer=code(2,'a@example.test','2026-09-28T09:48:14Z');
    const otherStudent=code(3,'b@example.test','2026-09-25T08:00:00Z');
    let rows=[older,newer,otherStudent];
    query=async sql=>({rows:sql.includes('FROM messages')?rows:sql.includes('lower(email) AS email')?[]:[{email:'a@example.test'}]});

    const page=await fetchThreadSummaries('all','staff@example.test','1',25,0);
    assert.deepEqual(page.threads.map(t=>t.threadId).sort(),[2,3],'older code for the same student is hidden; other students unaffected');
    assert.equal(page.counts.code_expired,2);
    assert.equal(page.counts.all,2);

    const expiredOnly=await fetchThreadSummaries('all','staff@example.test','1',25,0,undefined,'code_expired');
    assert.equal(expiredOnly.threads.filter(t=>t.student_email==='a@example.test').length,1);

    const searched=await fetchThreadSummaries('all','staff@example.test','1',25,0,'a@example.test');
    const byId=Object.fromEntries(searched.threads.map(t=>[t.threadId,t]));
    assert.equal(byId[1].badge,'used','superseded code still findable by search');
    assert.equal(byId[1].code_at,null);
    assert.equal(byId[2].badge,'code');

    const reply={...code(4,'a@example.test','2026-09-26T11:00:00Z'),message_id:'<r4>',sender_email:'a@example.test',edugate_kind:null,in_reply_to:'<c1>',reference_ids:['<c1>'],body_text:'I did not get it'};
    rows=[older,reply,newer];
    const withReply=await fetchThreadSummaries('all','staff@example.test','1',25,0);
    assert.equal(withReply.threads.length,2,'an older code thread with a human message stays visible');
});
