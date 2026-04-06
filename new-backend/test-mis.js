const { getRevenueMISReport } = require('./src/services/cfoAnalyticsService');
const { Agent } = require('./src/models/master');

async function test() {
  try {
    const brandId = 1; // Assuming 1
    const agent = await Agent.findOne({ where: { name: 'Sales-Amazon' } });
    if (!agent) {
      console.log('No amazon agent found');
      return;
    }
    const report = await getRevenueMISReport(brandId, agent.id, null, null);
    console.log(JSON.stringify(report, null, 2));
  } catch (err) {
    console.error(err);
  }
}
test();
