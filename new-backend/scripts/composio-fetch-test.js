// Throwaway test: verify central has googlesuper, list the Koparo folder, and
// inspect the DOWNLOAD_FILE response shape (bytes vs url vs base64).
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const c = require('../src/services/composioClient');
const FOLDER = '1ywK4YwD6Jhh9OFpo87z10_g6ALijnM5Y';

(async () => {
  console.log('central connections:', JSON.stringify(await c.listConnections('central')));

  // list files in folder
  const find = await c.executeTool('central', 'GOOGLESUPER_FIND_FILE', {
    folder_id: FOLDER, pageSize: 20, supportsAllDrives: true, includeItemsFromAllDrives: true,
  });
  const fd = (find && find.data) || {};
  console.log('FIND successful:', find && find.successful, '| data keys:', Object.keys(fd));
  let files = fd.files || (fd.response_data && fd.response_data.files) || [];
  if (!files.length) console.log('FIND raw (trunc):', JSON.stringify(fd).slice(0, 500));
  console.log('files:', files.map(f => ({ id: f.id, name: f.name })));

  // download the first file and inspect shape
  if (files[0]) {
    const dl = await c.executeTool('central', 'GOOGLESUPER_DOWNLOAD_FILE', { fileId: files[0].id });
    const d = (dl && dl.data) || {};
    console.log('\nDOWNLOAD successful:', dl && dl.successful, '| data keys:', Object.keys(d));
    // show shape without dumping megabytes
    const shape = {};
    for (const k of Object.keys(d)) {
      const v = d[k];
      if (typeof v === 'string') shape[k] = `string(len=${v.length}) "${v.slice(0, 80)}"`;
      else if (v && typeof v === 'object') shape[k] = `object{${Object.keys(v).join(',')}}`;
      else shape[k] = v;
    }
    console.log('DOWNLOAD shape:', JSON.stringify(shape, null, 2));
  }
})().catch(e => console.log('ERR:', e.message));
