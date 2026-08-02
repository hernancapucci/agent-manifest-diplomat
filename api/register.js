const https = require('https');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER || 'agent-manifest';
const DATASET_REPO = process.env.DATASET_REPO || 'agent-manifest-dataset';

// Single authoritative validator, and no longer this repository's own: the
// schema and the checking both come from @agent-manifest/client, which carries
// the canonical Agent Manifest v1.0 schema as a dependency. The copy that used
// to live at api/schema.json is gone rather than kept in sync.
//
// One visible consequence, and it is a change: a missing required field used to
// be reported at "/" and is now reported at the field itself — "/contact must
// have required property 'contact'" where it read "/ must have ...". The
// message is Ajv's own either way; what moved is the path the shared validator
// puts in front of it.
//
// It is loaded with import(), not require(). The validator is an ES module and
// this handler is CommonJS; Node has resolved that combination since 22.12, but
// Vercel does not run Node's module loader — it resolves require() with its own,
// which does not implement the interop, and the deployed function threw
// ERR_REQUIRE_ESM even with the project set to Node 24.x. import() is the one
// form both loaders implement. The promise is memoised, so a warm instance
// loads the module once rather than once per request.
let validatorPromise;

function loadValidator() {
  if (!validatorPromise) {
    validatorPromise = import('@agent-manifest/client/validate').then((m) => m.validate);
  }
  return validatorPromise;
}

async function validateManifest(manifest) {
  const validateAgainstSchema = await loadValidator();
  const { schemaValid, errors } = validateAgainstSchema(manifest);
  if (schemaValid) return [];
  return errors.map((e) => `${e.path} ${e.message}`);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

function githubRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;

    const options = {
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'agent-manifest-diplomat',
        'Content-Type': 'application/json',
        ...(data && { 'Content-Length': Buffer.byteLength(data) })
      }
    };

    const req = https.request(options, (res) => {
      let responseBody = '';

      res.on('data', (chunk) => {
        responseBody += chunk;
      });

      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode,
            data: responseBody ? JSON.parse(responseBody) : {}
          });
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on('error', reject);

    if (data) req.write(data);
    req.end();
  });
}

const defaultGithub = {
  async getFile(path) {
    const res = await githubRequest(
      'GET',
      `/repos/${GITHUB_OWNER}/${DATASET_REPO}/contents/${path}`
    );

    if (res.status === 404) return null;
    if (res.status !== 200) {
      // Auth/config failures must surface as errors, not as "file exists".
      throw new Error(`GitHub read failed (${res.status})`);
    }
    return res.data;
  },

  // Append-only by construction: no sha is ever sent, so GitHub refuses to
  // update an existing file (422) instead of silently overwriting it.
  async putFile(path, content, message) {
    const body = {
      message,
      content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64')
    };

    return githubRequest(
      'PUT',
      `/repos/${GITHUB_OWNER}/${DATASET_REPO}/contents/${path}`,
      body
    );
  }
};

function decodeFileJson(file) {
  try {
    return JSON.parse(Buffer.from(file.content, 'base64').toString('utf-8'));
  } catch (err) {
    return null;
  }
}

function createHandler(github) {
  return async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }

    if (req.method !== 'POST') {
      return res.status(405).json({
        status: 'error',
        message: 'Method not allowed'
      });
    }

    const manifest = req.body;

    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      return res.status(400).json({
        status: 'rejected',
        errors: ['Invalid JSON body']
      });
    }

    const errors = await validateManifest(manifest);

    if (errors.length > 0) {
      return res.status(400).json({
        status: 'rejected',
        errors
      });
    }

    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const agentId = manifest.agent_id;
    const filePath = `manifests/${year}/${month}/${agentId}.json`;

    try {
      // The dataset is append-only: an agent_id may be registered once.
      const existing = await github.getFile(filePath);

      if (existing) {
        const stored = decodeFileJson(existing);

        if (stored && deepEqual(stored, manifest)) {
          return res.status(200).json({
            status: 'already_registered',
            agent_id: agentId,
            stored_at: filePath,
            registry_updated: false
          });
        }

        return res.status(409).json({
          status: 'rejected',
          errors: [
            `agent_id '${agentId}' is already registered at ${filePath}. ` +
              'The dataset is append-only; resubmission does not replace an existing declaration.'
          ]
        });
      }

      const registryFile = await github.getFile('registry.json');

      if (registryFile) {
        const registry = decodeFileJson(registryFile);
        const wanted = `${agentId.toLowerCase()}.json`;
        const priorPath = ((registry && registry.agents) || []).find(
          (p) => typeof p === 'string' && p.split('/').pop().toLowerCase() === wanted
        );

        if (priorPath) {
          return res.status(409).json({
            status: 'rejected',
            errors: [
              `agent_id '${agentId}' is already registered at ${priorPath}. ` +
                'The dataset is append-only; resubmission does not replace an existing declaration.'
            ]
          });
        }
      }

      const fileWrite = await github.putFile(
        filePath,
        manifest,
        `Register agent: ${agentId}`
      );

      if ([409, 422].includes(fileWrite.status)) {
        return res.status(409).json({
          status: 'rejected',
          errors: [
            `agent_id '${agentId}' was registered concurrently. ` +
              'The dataset is append-only; resubmission does not replace an existing declaration.'
          ]
        });
      }

      if (fileWrite.status !== 201) {
        return res.status(500).json({
          status: 'error',
          message: `GitHub file write failed (${fileWrite.status})`
        });
      }

      return res.status(200).json({
        status: 'accepted',
        agent_id: agentId,
        stored_at: filePath,
        registry_updated: false
      });
    } catch (err) {
      return res.status(500).json({
        status: 'error',
        message: err.message
      });
    }
  };
}

module.exports = createHandler(defaultGithub);
module.exports.createHandler = createHandler;
module.exports.validateManifest = validateManifest;
