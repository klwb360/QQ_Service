'use strict';

const path = require('node:path');
const { createSignedBuildConfiguration } = require('./scripts/signing-certificate.cjs');

module.exports = createSignedBuildConfiguration({
  projectRoot: __dirname,
  version: require('./package.json').version,
  // Explicit public-certificate override is used only by disposable Windows
  // fixtures. Production jobs use the checked-in publisher certificate.
  certificateDirectory: process.env.QQ_SERVICE_SIGNING_PUBLIC_DIR
    ? path.resolve(process.env.QQ_SERVICE_SIGNING_PUBLIC_DIR) : path.join(__dirname, 'signing'),
});
