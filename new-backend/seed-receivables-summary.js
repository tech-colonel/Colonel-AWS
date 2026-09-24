/* Create the Receivables Summary agent. Safe to re-run: it updates the column
   list on an existing agent rather than creating a second one. Local only. */
const { masterSequelize } = require('./src/config/database');
const { Agent } = require('./src/models/master/index.js');
const { COLUMNS } = require('./src/controllers/agents/receivables-summary/receivablesSummaryController');

const NAME = 'Receivables Summary';
const DESCRIPTION =
  'What the channel still owes you. Reads the delivered, refund and RTO tabs of each GST '
  + 'registration\'s sales workbook together with the payment reconciliation, joins them per order, '
  + 'and produces the receivable with its worklists.';

(async () => {
  try {
    await masterSequelize.authenticate();
    const existing = await Agent.findOne({ where: { name: NAME } });
    if (existing) {
      await existing.update({ description: DESCRIPTION, columns: COLUMNS });
      console.log(`✓ ${NAME} already existed — description and ${COLUMNS.length} columns refreshed (id ${existing.id})`);
    } else {
      const a = await Agent.create({ name: NAME, description: DESCRIPTION, columns: COLUMNS });
      console.log(`✓ ${NAME} created with ${COLUMNS.length} columns (id ${a.id})`);
    }
    process.exit(0);
  } catch (e) {
    console.error('Seed error:', e.message);
    process.exit(1);
  }
})();
