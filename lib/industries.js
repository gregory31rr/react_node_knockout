/**
 * lib/industries.js — role lists and wording for different kinds of teams.
 *
 * Each workspace picks one (Settings → Your team). It sets the roles you can give people (so "Who has room?" can show
 * just your developers or just your BAs) and what a project is called. Technology is first; the others are ready to use.
 * To add one, add an entry here: { name, project, roles: [...] }.
 */
const INDUSTRIES = {
  technology: { name: 'Technology / software', project: 'Project', roles: ['Developer', 'Senior developer', 'Tech lead', 'Architect', 'Business analyst', 'Scrum master', 'Product owner', 'Product manager', 'Project manager', 'QA / test', 'DevOps / SRE', 'Data engineer', 'Data analyst', 'Reporting / BI', 'Designer / UX', 'Security', 'Support', 'Contractor'] },
  legal: { name: 'Legal', project: 'Matter', roles: ['Partner', 'Associate', 'Paralegal', 'Legal assistant', 'Counsel', 'Contracts manager', 'Compliance', 'Investigator', 'Intake', 'Billing'] },
  delivery: { name: 'Delivery & logistics', project: 'Route / account', roles: ['Driver', 'Lead driver', 'Dispatcher', 'Warehouse', 'Loader', 'Fleet / mechanic', 'Route planner', 'Customer service', 'Safety'] },
  construction: { name: 'Construction & field service', project: 'Job', roles: ['Project manager', 'Superintendent', 'Foreman', 'Electrician', 'Plumber', 'Carpenter', 'Technician', 'Estimator', 'Safety', 'Apprentice'] },
  healthcare: { name: 'Healthcare', project: 'Initiative', roles: ['Physician', 'Nurse', 'Nurse manager', 'Medical assistant', 'Front desk', 'Billing / coding', 'Pharmacist', 'Therapist', 'Admin'] },
  sales: { name: 'Sales & customer success', project: 'Account', roles: ['Account executive', 'SDR / BDR', 'Account manager', 'Customer success', 'Sales engineer', 'Sales ops', 'Partner manager'] },
  marketing: { name: 'Marketing & creative', project: 'Campaign', roles: ['Marketing manager', 'Content writer', 'Designer', 'Social media', 'SEO / web', 'Video', 'Events', 'Analyst'] },
  operations: { name: 'Operations & HR', project: 'Project', roles: ['Operations manager', 'Coordinator', 'HR partner', 'Recruiter', 'Finance', 'Facilities', 'Procurement', 'Admin'] },
  general: { name: 'Something else', project: 'Project', roles: ['Team member', 'Lead', 'Specialist', 'Contractor', 'Intern'] },
};
const of = ws => INDUSTRIES[ws?.industry] || INDUSTRIES.technology;
module.exports = { INDUSTRIES, of };
