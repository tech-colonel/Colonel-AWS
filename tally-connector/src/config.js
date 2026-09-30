/**
 * config.js — where the connector keeps its settings and logs.
 *   Windows : %APPDATA%\ColonelTallyConnector\
 *   others  : ~/.colonel-tally-connector/
 *   override: COLONEL_CONNECTOR_HOME
 *
 * config.json holds the connector TOKEN (never the password), Tally host/port,
 * the selected companies and the sync interval.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULTS = {
  server_url: 'https://agent.accountant',
  token: null,
  connector_id: null,
  user_email: null,
  tally_host: 'localhost',
  tally_port: 9002,
  companies: [],            // empty = every company open in Tally
  interval_minutes: 15,
  machine_name: os.hostname(),
};

const home = () => process.env.COLONEL_CONNECTOR_HOME
  || (process.platform === 'win32' && process.env.APPDATA
    ? path.join(process.env.APPDATA, 'ColonelTallyConnector')
    : path.join(os.homedir(), '.colonel-tally-connector'));

const file = () => path.join(home(), 'config.json');

function load() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) }; }
  catch (_) { return { ...DEFAULTS }; }
}

function save(cfg) {
  fs.mkdirSync(home(), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

module.exports = { DEFAULTS, home, file, load, save };
