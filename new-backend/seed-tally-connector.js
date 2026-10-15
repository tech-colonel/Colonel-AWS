/* Create the Tally Connector agent and put it on one brand.

     node seed-tally-connector.js "Shumee Playroom"
     node seed-tally-connector.js --all          # every brand except "Other"

   Safe to re-run: it refreshes the description of an existing agent and adds the
   brand link only if it is missing. It creates a row in `agents` and one in
   `brand_agents`, and touches nothing else. Which Tally company the brand sees is
   chosen afterwards, by an admin, on the agent's own page. */
const { Brand, Agent, BrandAgent } = require('./src/models/master');

const NAME = 'Tally Connector';
const DESCRIPTION =
  'Your Tally books, live. The Colonel Tally Connector on the Tally PC sends ledgers and '
  + 'vouchers here every 15 minutes — browse companies, ledgers with balances, vouchers with '
  + 'their ledger lines, and the sync history.';

(async () => {
  try {
    const brandName = process.argv[2];
    if (!brandName) throw new Error('Pass the brand name, e.g. node seed-tally-connector.js "Shumee Playroom", or --all');
    // Only the columns needed: a database that is behind on brand migrations still works.
    const brands = brandName === '--all'
      ? (await Brand.findAll({ attributes: ['id', 'name'], order: [['name', 'ASC']] })).filter((b) => b.name !== 'Other')
      : [await Brand.findOne({ where: { name: brandName }, attributes: ['id', 'name'] })];
    if (!brands[0]) throw new Error(`Brand "${brandName}" not found`);

    let agent = await Agent.findOne({ where: { name: NAME } });
    if (agent) {
      await agent.update({ description: DESCRIPTION });
      console.log(`✓ ${NAME} already existed — description refreshed (id ${agent.id})`);
    } else {
      agent = await Agent.create({ name: NAME, description: DESCRIPTION, columns: [] });
      console.log(`✓ ${NAME} created (id ${agent.id})`);
    }

    for (const brand of brands) {
      const [, made] = await BrandAgent.findOrCreate({
        where: { brand_id: brand.id, agent_id: agent.id },
        defaults: { brand_id: brand.id, agent_id: agent.id },
      });
      console.log(made ? `✓ "${NAME}" linked to ${brand.name}` : `✓ "${NAME}" already linked to ${brand.name}`);
    }
    process.exit(0);
  } catch (e) {
    console.error('Seed error:', e.message);
    process.exit(1);
  }
})();
