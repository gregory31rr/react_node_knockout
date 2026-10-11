/**
 * seed.js — sample data so you can click around (SEED_DEMO=1, only on an EMPTY database). All passwords: demo1234.
 * NEVER turn SEED_DEMO on for your real database.
 *
 *   greg@demo.test   Greg Rivera, the manager and app owner (Platform Engineering, 14 people, a boss and peers)
 *   priya@demo.test  Priya Natarajan, a developer with her own account (sees her own list)
 */
const { one, all, run, tx } = require('./lib/db');
const U = require('./lib/util');

async function seedIfEmpty() {
  if (await one('SELECT 1 x FROM users LIMIT 1')) return;
  const pw = U.hashPassword('demo1234'), t = U.today(), d = n => U.addDays(t, n), at = (n, h = 10) => `${d(n)} ${String(h).padStart(2, '0')}:15:00`;
  await tx(async () => {
    const ws = (await run("INSERT INTO workspaces(name,plan,industry,hours_per_day) VALUES('Platform Engineering','pro','technology',6)")).id;
    const greg = (await run("INSERT INTO users(email,name,pass_hash,workspace_id,platform_role,last_login_at,connect_code) VALUES('greg@demo.test','Greg Rivera',?,?,'owner',?,'KO-GREG-2026')", pw, ws, at(0, 8))).id;
    await run("INSERT INTO memberships(user_id,workspace_id,role) VALUES(?,?,'admin')", greg, ws);
    const P = {};
    const person = async (key, name, role, team, relation = 'report', email = true, hpd = null) => {
      P[key] = (await run('INSERT INTO people(workspace_id,name,handle,email,role,team,relation,hours_per_day) VALUES(?,?,?,?,?,?,?,?)', ws, name, key, email ? `${key}@demo.test` : null, role, team, relation, hpd)).id;
    };
    await person('dana', 'Dana Whitfield', 'Director of Engineering', null, 'boss');
    await person('marcus', 'Marcus Lee', 'Engineering manager', null, 'peer');
    await person('elena', 'Elena Brooks', 'Product manager', null, 'peer');
    await person('priya', 'Priya Natarajan', 'Senior developer', 'Cloud');
    await person('john', 'John Smith', 'Architect', 'Cloud');
    await person('sam', 'Sam Okafor', 'DevOps / SRE', 'Cloud');
    await person('jane', 'Jane Doe', 'Business analyst', 'Data');
    await person('luis', 'Luis Romero', 'Developer', 'Cloud');
    await person('aisha', 'Aisha Khan', 'Data engineer', 'Data');
    await person('tom', 'Tom Becker', 'Scrum master', 'Delivery');
    await person('mei', 'Mei Chen', 'QA / test', 'Delivery');
    await person('ravi', 'Ravi Patel', 'Reporting / BI', 'Data');
    await person('kate', 'Kate Moreno', 'Developer', 'Apps');
    await person('ben', 'Ben Carter', 'Developer', 'Apps', 'report', true, 4);
    await person('olivia', 'Olivia Grant', 'Designer / UX', 'Apps');
    await person('noah', 'Noah Kim', 'Data analyst', 'Data');
    await person('vendor', 'Hector (CloudCo)', 'Contractor', null, 'partner', false);
    await run('UPDATE workspaces SET boss_person_id=? WHERE id=?', P.dana, ws);
    const priyaU = (await run("INSERT INTO users(email,name,pass_hash,workspace_id,last_login_at,connect_code) VALUES('priya@demo.test','Priya Natarajan',?,?,?,'KO-PRIY-A7K2')", pw, ws, at(-1))).id;
    await run("INSERT INTO memberships(user_id,workspace_id,role) VALUES(?,?,'member')", priyaU, ws);
    const priyaWs = (await run("INSERT INTO workspaces(name,plan) VALUES('Priya''s workspace','pro')")).id;   // her own space too
    await run("INSERT INTO memberships(user_id,workspace_id,role) VALUES(?,?,'admin')", priyaU, priyaWs);
    // Dana (Greg's director) has her own Knockout and asked to connect as Greg's boss
    const danaWs = (await run("INSERT INTO workspaces(name,plan) VALUES('Engineering leadership','pro')")).id;
    const danaU = (await run("INSERT INTO users(email,name,pass_hash,workspace_id,connect_code) VALUES('dana@demo.test','Dana Whitfield',?,?,'KO-DANA-55WX')", pw, danaWs)).id;
    await run("INSERT INTO memberships(user_id,workspace_id,role) VALUES(?,?,'admin')", danaU, danaWs);
    await run("INSERT INTO connections(from_user,from_ws,to_user,relation,role,message) VALUES(?,?,?,'report','Engineering manager','Connecting so I can see your weekly updates.')", danaU, danaWs, greg);
    await run('UPDATE people SET user_id=?, access=? WHERE id=?', priyaU, 'projects', P.priya);
    const proj = async (name, tag, goal, owner, due, status = 'active', start = -60) => (await run('INSERT INTO projects(workspace_id,name,tag,goal,owner_person_id,status,start_on,due_on) VALUES(?,?,?,?,?,?,?,?)', ws, name, tag, goal, owner, status, d(start), due)).id;
    const gcp = await proj('GCP migration', 'gcp', 'Move the 14 core services from the data center to Google Cloud with no customer downtime. Done = data center contract can end Jan 31.', P.john, d(48));
    const data = await proj('Data platform', 'data', 'One warehouse for finance and ops reporting; retire the three old marts.', P.aisha, d(75));
    const q4 = await proj('Q4 exec reporting', 'q4rpt', 'Weekly KPI pack for the leadership team, automated.', P.ravi, d(20));
    const mob = await proj('Customer app v2', 'mobile', 'New onboarding and payments in the customer app.', P.kate, d(34));
    const sec = await proj('SOC 2 readiness', 'soc2', 'Evidence for every control before the auditor visit.', null, d(-5), 'done', -120);
    await run('UPDATE projects SET completed_at=? WHERE id=?', at(-6), sec);
    const item = async (o) => {
      const r = await run(`INSERT INTO items(workspace_id,kind,title,details,project_id,person_id,owner_person_id,priority,loe,status,due_on,answer,answered_at,created_by,created_at,completed_at,completed_by,delegated_at,exec,private)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ws, o.kind || 'task', o.title, o.details || null, o.project || null, o.person || null, o.owner || null, o.p || 3, o.loe ?? null, o.done != null ? 'done' : (o.status || 'open'),
        o.due != null ? d(o.due) : null, o.answer || null, o.answer ? at(o.done ?? -1) : null, greg, at(o.created ?? Math.min(-2, (o.done ?? 0) - 6)), o.done != null ? at(o.done, 15) : null, o.done != null ? (o.owner ? 'Team' : 'Greg Rivera') : null, o.owner ? at(o.created ?? -5) : null, o.exec ? 1 : 0, o.private ? 1 : 0);
      await run('INSERT INTO item_events(item_id,workspace_id,kind,actor,created_at) VALUES(?,?,?,?,?)', r.id, ws, 'created', 'Greg Rivera', at(o.created ?? -5));
      if (o.done != null) await run('INSERT INTO item_events(item_id,workspace_id,kind,actor,created_at) VALUES(?,?,?,?,?)', r.id, ws, 'knocked out', 'Greg Rivera', at(o.done, 15));
      if (o.spent) await run('INSERT INTO time_logs(workspace_id,item_id,person_id,who,hours,note,on_day) VALUES(?,?,?,?,?,?,?)', ws, r.id, o.owner || null, 'Team', o.spent, 'Progress', d(o.done ?? -1));
      return r.id;
    };
    // open work: mine
    await item({ kind: 'ask', title: 'Confirm cutover window for the billing service', project: gcp, person: P.john, p: 1, due: 1, exec: 1 });
    await item({ kind: 'ask', title: 'Is the network peering request approved by security?', project: gcp, person: P.sam, p: 2, due: 2 });
    await item({ kind: 'update', title: 'Status on the IAM role mapping', project: gcp, person: P.priya, p: 2, due: 0 });
    await item({ kind: 'tell', title: 'Budget for the extra GCP credits was approved', project: gcp, person: P.john });
    await item({ kind: 'tell', title: 'Headcount request moved to Q1', person: P.tom });
    await item({ kind: 'ask', title: 'Can the finance mart retire before the warehouse is live?', project: data, person: P.aisha, due: 6 });
    await item({ kind: 'update', title: 'Where are we on the KPI definitions?', project: q4, person: P.ravi, p: 2, due: 1 });
    await item({ kind: 'ask', title: 'Approve contractor extension through January', person: P.dana, p: 1, due: 3, exec: 1 });
    await item({ kind: 'decision', title: 'Pick the cloud SQL tier for reporting', project: data, person: P.dana, due: 9, exec: 1 });
    await item({ kind: 'update', title: 'Onboarding redesign: ready for usability test?', project: mob, person: P.olivia, due: 4 });
    await item({ kind: 'task', title: 'Write the Q4 cost forecast for GCP', project: gcp, p: 1, loe: 6, due: 2, exec: 1 });
    await item({ kind: 'task', title: 'Prep talking points for the leadership review', p: 2, loe: 3, due: 1 });
    await item({ kind: 'task', title: 'Review Luis’s rollback plan', project: gcp, loe: 1.5, due: 3 });
    await item({ kind: 'task', title: 'Performance check-ins for the Data team', loe: 4, due: 12, private: 1 });
    await item({ kind: 'task', title: 'Draft the 2027 roadmap one-pager', loe: 8, due: 20 });
    await item({ kind: 'task', title: 'Clean up the vendor contracts folder', p: 4, loe: 2 });
    await item({ kind: 'task', title: 'Set up access reviews for the warehouse', project: data, p: 2, loe: 5, due: -2 });
    // open work: the team
    const team = [
      ['Migrate the auth service to GKE', gcp, P.priya, 1, 16, 5, 6], ['Terraform for shared VPC', gcp, P.sam, 2, 12, 3, 4], ['Rollback plan for billing cutover', gcp, P.luis, 1, 6, 2, 0],
      ['Load test the payments API on GCP', gcp, P.mei, 2, 8, 6, 0], ['Data transfer plan for the 40 TB archive', gcp, P.john, 2, 10, 9, 2], ['Cost tagging standard', gcp, P.sam, 3, 4, 12, 0],
      ['Finance model in the warehouse', data, P.aisha, 2, 20, 14, 8], ['Map old mart fields to the new model', data, P.jane, 2, 12, 8, 3], ['Data quality checks for orders', data, P.noah, 3, 8, 15, 0],
      ['Automate the weekly KPI pack', q4, P.ravi, 1, 14, 5, 6], ['Exec dashboard mockups', q4, P.olivia, 2, 6, 3, 2], ['Revenue KPI definitions with finance', q4, P.jane, 1, 5, -1, 1],
      ['Payments screen build', mob, P.kate, 1, 24, 10, 10], ['Onboarding flow build', mob, P.ben, 2, 20, 9, 4], ['Regression test plan for v2', mob, P.mei, 3, 6, 18, 0],
      ['Sprint planning for the cloud squad', null, P.tom, 3, 2, 1, 0], ['Accessibility review of the new screens', mob, P.olivia, 3, 4, 16, 0],
    ];
    for (const [title, project, owner, p, loe, due, spent] of team) await item({ title, project, owner, p, loe, due, spent, status: spent ? 'doing' : 'open' });
    const vend = await item({ title: 'Patch the build agents (outside contractor)', project: gcp, owner: P.vendor, loe: 3, due: 3 });
    await run("INSERT INTO links(workspace_id,token,item_id,who,expires_on) VALUES(?,?,?,?,?)", ws, 'demo-vendor-link-hector-cloudco-0001', vend, 'Hector at CloudCo', d(7));
    await item({ kind: 'update', title: 'Weekly status on the archive copy', project: gcp, person: P.vendor, due: 2 });
    // done over the last 12 weeks (for Insights)
    const doneTitles = ['Inventory of all 14 services', 'Landing zone design', 'Security review of the landing zone', 'Pick the migration order', 'Billing service dry run', 'Exec kickoff deck', 'SOC 2 evidence: access reviews',
      'SOC 2 evidence: change management', 'Warehouse vendor shortlist', 'Hire contractor for archive copy', 'KPI list agreed with Dana', 'Onboarding research interviews', 'Payments vendor contract', 'Fix flaky CI tests', 'Retire the old VPN',
      'DR test for the data center', 'Quarterly business review prep', 'Update the on-call runbook', 'Monitoring dashboards in Cloud Monitoring', 'Service accounts cleanup', 'Mart usage report', 'Customer app crash fixes', 'Release 1.9 of the app', 'Design system tokens'];
    const owners = [P.priya, P.john, P.sam, P.luis, P.aisha, P.jane, P.ravi, P.kate, P.ben, P.mei, P.olivia, P.tom, P.noah, null];
    const projs = [gcp, gcp, gcp, gcp, gcp, null, sec, sec, data, gcp, q4, mob, mob, mob, gcp, gcp, null, gcp, gcp, gcp, data, mob, mob, mob];
    for (let k = 0; k < 70; k++) {
      const done = -Math.floor(k * 1.15) - (k % 3), owner = owners[k % owners.length], title = doneTitles[k % doneTitles.length] + (k >= doneTitles.length ? ` (part ${Math.floor(k / doneTitles.length) + 1})` : '');
      await item({ title, project: projs[k % projs.length], owner, loe: [2, 4, 6, 8, 3, 1.5, 5][k % 7], done, due: done + [1, 2, -1, 0, 3, -2][k % 6], spent: k % 4 === 0 ? 3 : 0, created: done - 5 - (k % 9) });
    }
    await item({ kind: 'ask', title: 'Did the security team sign off on the landing zone?', project: gcp, person: P.sam, done: -9, answer: 'Yes, signed off by Ana on the security team. Two small fixes were done the same week.' });
    // calls
    const call = async (title, kind, when, status, people, projects, notes) => {
      const m = (await run('INSERT INTO meetings(workspace_id,title,kind,starts_at,status,notes,ended_at) VALUES(?,?,?,?,?,?,?)', ws, title, kind, when, status, notes || null, status === 'done' ? when : null)).id;
      for (const p of people) await run('INSERT INTO meeting_people(meeting_id,person_id) VALUES(?,?)', m, p);
      for (const p of projects) await run('INSERT INTO meeting_projects(meeting_id,project_id) VALUES(?,?)', m, p);
      return m;
    };
    await call('GCP migration standup', 'project', at(0, 15), 'planned', [P.john, P.sam, P.priya, P.luis, P.mei], [gcp]);
    await call('1:1 with Ravi', 'one_on_one', at(1, 11), 'planned', [P.ravi], []);
    await call('Weekly with Dana', 'boss', at(2, 14), 'planned', [P.dana], []);
    await call('1:1 with Priya', 'one_on_one', at(-7, 11), 'done', [P.priya], [], 'Wants to lead the auth cutover. Talked about the architect track.');
    await call('Data platform check-in', 'project', at(-3, 13), 'done', [P.aisha, P.jane, P.noah], [data], 'Finance model slipping a week; Jane to help with field mapping.');
    // goals
    await run("INSERT INTO goals(workspace_id,name,metric,target,period) VALUES(?,?,?,?,?)", ws, 'Team knocks out 6 items a week', 'items_done', 6, 'week');
    await run("INSERT INTO goals(workspace_id,name,metric,target,period) VALUES(?,?,?,?,?)", ws, '30 hours of LOE a week', 'loe_done', 30, 'week');
    await run("INSERT INTO goals(workspace_id,name,metric,target,period) VALUES(?,?,?,?,?)", ws, '85% on time this quarter', 'on_time', 85, 'quarter');
    await run("INSERT INTO goals(workspace_id,name,metric,target,period,project_id) VALUES(?,?,?,?,?,?)", ws, 'GCP migration done', 'project_done', 100, 'quarter', gcp);
    // time off, notes, reminders
    const off = (pid, kind, a, b, hours = null, status = 'approved', note = null) => run('INSERT INTO time_off(workspace_id,person_id,kind,start_on,end_on,hours,status,note) VALUES(?,?,?,?,?,?,?,?)', ws, pid, kind, d(a), d(b), hours, status, note);
    await run('UPDATE people SET pto_hours_year=120 WHERE workspace_id=? AND relation=?', ws, 'report');
    await off(P.sam, 'pto', 0, 2); await off(P.ben, 'sick', 0, 0); await off(P.mei, 'remote', 0, 4); await off(P.kate, 'pto', 7, 11, null, 'approved', 'Family trip');
    await off(P.luis, 'pto', 14, 15, null, 'requested'); await off(null, 'holiday', 21, 21, null, 'approved', 'Company holiday');
    await off(P.jane, 'pto', -40, -36); await off(P.priya, 'pto', -70, -61); await off(P.ravi, 'absent', -12, -12); await off(P.aisha, 'sick', -20, -19); await off(P.noah, 'training', 3, 3);
    const cert = (pid, name, issuer, earned, expires, required = 0) => run('INSERT INTO certs(workspace_id,person_id,name,issuer,earned_on,expires_on,required) VALUES(?,?,?,?,?,?,?)', ws, pid, name, issuer, d(earned), expires == null ? null : d(expires), required);
    await cert(P.john, 'Google Cloud Professional Architect', 'Google Cloud', -700, 25, 1); await cert(P.sam, 'Certified Kubernetes Administrator', 'CNCF', -1000, 70, 1); await cert(P.sam, 'AWS SysOps Administrator', 'AWS', -1100, -3);
    await cert(P.tom, 'Certified ScrumMaster', 'Scrum Alliance', -680, 50, 1); await cert(P.jane, 'CBAP', 'IIBA', -400, 700); await cert(P.mei, 'ISTQB Foundation', 'ISTQB', -900, null); await cert(P.ravi, 'Power BI Data Analyst', 'Microsoft', -300, 65);
    const course = async (pid, name, provider, hours, start, target, progress, certName, logs) => { const c = (await run("INSERT INTO trainings(workspace_id,person_id,name,provider,hours_total,started_on,target_on,progress,status,cert_name) VALUES(?,?,?,?,?,?,?,?,'in_progress',?)", ws, pid, name, provider, hours, d(start), d(target), progress, certName)).id;
      for (const [dd, h, pc] of logs) await run('INSERT INTO training_logs(training_id,hours,progress,note,who,on_day) VALUES(?,?,?,?,?,?)', c, h, pc, 'Progress', 'Team', d(dd)); };
    await course(P.priya, 'GCP Professional Cloud Architect prep', 'Coursera', 40, -30, 30, 55, 'Google Cloud Professional Architect', [[-25, 6, 15], [-14, 8, 35], [-4, 6, 55]]);
    await course(P.luis, 'Terraform Associate prep', 'HashiCorp Learn', 20, -40, 5, 30, 'HashiCorp Terraform Associate', [[-35, 3, 10], [-20, 4, 30]]);
    await course(P.aisha, 'dbt Fundamentals', 'dbt Labs', 8, -10, 20, 80, null, [[-6, 6, 80]]);
    await course(P.noah, 'SQL for analysts', 'In-house', 12, 3, 40, 0, null, []);
    const note = (text, color, pinned, pid = null, prj = null) => run('INSERT INTO notes(workspace_id,user_id,text,color,pinned,person_id,project_id) VALUES(?,?,?,?,?,?,?)', ws, greg, text, color, pinned, pid, prj);
    await note('Dana wants the GCP cost forecast in the Thursday deck, not as a separate doc.', 'yellow', 1, P.dana, gcp);
    await note('Priya: interested in the architect track. Pair her with John on the data transfer design.', 'green', 0, P.priya);
    await note('Ideas for the offsite:\n- demo day\n- retire 3 old dashboards\n- team lunch', 'blue', 0);
    await note('Vendor renewal (CloudCo) is due Nov 30. Ask procurement for the quote.', 'purple', 1, null, gcp);
    const rem = (text, at, repeat = 'none') => run('INSERT INTO reminders(workspace_id,user_id,text,remind_at,repeat) VALUES(?,?,?,?,?)', ws, greg, text, at, repeat);
    await rem('Send the weekly update to Dana', at(0, 13), 'weekly'); await rem('Check in on Ben (out sick)', at(0, 16)); await rem('Book the room for the offsite', at(2, 14));
    await run("INSERT INTO notifications(user_id,text,link) VALUES(?,?,?)", greg, '🥊 Priya Natarajan knocked out: Service accounts cleanup', '/items');
  });
  console.log('Seeded demo data. Sign in as greg@demo.test / demo1234 (team member: priya@demo.test)');
}
module.exports = { seedIfEmpty };
