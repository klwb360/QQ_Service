const path = require('node:path');
const { verifyBackendResources } = require('./backend-resources.cjs');

if (require.main === module) {
  verifyBackendResources(path.resolve(process.argv[2] || 'build/backend')).then(result => {
    console.log(`Verified staged backend resources without external services: ${JSON.stringify(result)}`);
  }).catch(error => {
    console.error(`Staged backend verification failed: ${error.message}`);
    process.exitCode = 1;
  });
}
