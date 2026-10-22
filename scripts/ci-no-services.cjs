// CI test/sample steps must work without local services or credential files.
globalThis.fetch = async function () { throw new Error('CI_SERVICE_NETWORK_FORBIDDEN'); };
process.loadEnvFile = function () { throw new Error('CI_CREDENTIAL_FILE_FORBIDDEN'); };
