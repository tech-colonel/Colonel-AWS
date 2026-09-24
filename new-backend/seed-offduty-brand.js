/* Create the Off Duty brand and give it the Receivables Summary agent — and
   ONLY that agent, on ONLY that brand.

   Safe to re-run. Local only: on a unified database createBrandDatabase is a
   no-op, so this creates a row in `brands` and a link in `brand_agents`, and
   touches nothing else. */
const { Brand, Agent, BrandAgent, User, BrandUser } = require('./src/models/master');

const BRAND = 'Off Duty';
const DB_NAME = 'colonel_off_duty';
const AGENT = 'Receivables Summary';
const DESCRIPTION = 'D2C apparel. Shopify direct, three GST registrations (Haryana, Karnataka, '
                  + 'Maharashtra). Receivables reconciled from the GSTR-1 workbooks against the '
                  + 'payment reconciliation.';

(async () => {
  try {
    const agent = await Agent.findOne({ where: { name: AGENT } });
    if (!agent) throw new Error(`Agent "${AGENT}" not found — run seed-receivables-summary.js first`);

    let brand = await Brand.findOne({ where: { name: BRAND } });
    if (brand) {
      console.log(`✓ brand "${BRAND}" already exists (${brand.id})`);
    } else {
      brand = await Brand.create({ name: BRAND, db_name: DB_NAME, description: DESCRIPTION });
      console.log(`✓ brand "${BRAND}" created (${brand.id}, db_name ${DB_NAME})`);
    }

    const [, made] = await BrandAgent.findOrCreate({
      where: { brand_id: brand.id, agent_id: agent.id },
      defaults: { brand_id: brand.id, agent_id: agent.id },
    });
    console.log(made ? `✓ "${AGENT}" linked to ${BRAND}` : `✓ "${AGENT}" already linked to ${BRAND}`);

    /* The agent must appear on Off Duty and nowhere else. Report any other
       brand it is linked to rather than silently unlinking someone's work. */
    const others = await BrandAgent.findAll({ where: { agent_id: agent.id } });
    const strays = others.filter((l) => l.brand_id !== brand.id);
    if (strays.length) {
      const names = await Brand.findAll({ where: { id: strays.map((s) => s.brand_id) }, raw: true });
      console.log(`\n!  "${AGENT}" is ALSO linked to: ${names.map((n) => n.name).join(', ')}`);
      console.log('   Re-run with --exclusive to remove those links.');
      if (process.argv.includes('--exclusive')) {
        await BrandAgent.destroy({ where: { id: strays.map((s) => s.id) } });
        console.log('   removed.');
      }
    }

    /* What Off Duty can see. Anything already linked stays — this script adds,
       it does not prune a brand's agent list. */
    const mine = await BrandAgent.findAll({ where: { brand_id: brand.id }, raw: true });
    const agentRows = await Agent.findAll({ where: { id: mine.map((m) => m.agent_id) }, raw: true });
    console.log(`\n${BRAND} has ${agentRows.length} agent(s): ${agentRows.map((a) => a.name).join(', ')}`);

    const admins = await User.findAll({ where: { role: 'admin' }, raw: true });
    console.log(`\nVisible to ${admins.length} admin user(s) without assignment (admins see every brand).`);
    console.log('Assign an accountant to it from Admin → Assignments if a non-admin needs it.');
    process.exit(0);
  } catch (e) {
    console.error('Seed error:', e.message);
    process.exit(1);
  }
})();
