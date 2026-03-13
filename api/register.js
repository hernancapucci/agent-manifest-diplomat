const https = require('https');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = 'hernancapucci';
const DATASET_REPO = 'agent-manifest-dataset';

const REQUIRED_FIELDS = [
  'manifest_version',
  'agent_id',
  'agent_name',
  'purpose'
];

function validateManifest(manifest) {
  const errors = [];

  if (manifest.manifest_version !== '1.0') {
    errors.push("manifest_version must be '1.0'");
  }

  for (const field of REQUIRED_FIELDS) {
    if (!manifest[field]) {
      errors.push(`${field} is required`);
    }
  }

  if (manifest.agent_id && !/^[a-zA-Z0-9._-]+$/.test(manifest.agent_id)) {
    errors.push('agent_id contains invalid characters');
  }

  return errors;
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
      let body = '';

      res.on('data', (chunk) => {
        body += chunk;
      });

      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode,
            data: body ? JSON.parse(body) : {}
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

async function getFile(path) {
  const res = await githubRequest(
    'GET',
    `/repos/${GITHUB_OWNER}/${DATASET_REPO}/contents/${path}`
  );

  if (res.status === 404) return null;
  return res.data;
}

async function putFile(path, content, message, sha) {
  const body = {
    message,
    content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64'),
    ...(sha && { sha })
  };

  return githubRequest(
    'PUT',
    `/repos/${GITHUB_OWNER}/${DATASET_REPO}/contents/${path}`,
    body
  );
}

export default async function handler(req, res) {
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

  if (!manifest || typeof manifest !== 'object') {
    return res.status(400).json({
      status: 'rejected',
      errors: ['Invalid JSON body']
    });
  }

  if (!manifest.agent_name && manifest.identity) {
    manifest.agent_name = manifest.identity;
  }

  const errors = validateManifest(manifest);

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
    const existing = await getFile(filePath);

    const fileWrite = await putFile(
      filePath,
      manifest,
      `Register agent: ${agentId}`,
      existing ? existing.sha : undefined
    );

    if (![200, 201].includes(fileWrite.status)) {
      return res.status(500).json({
        status: 'error',
        message: `GitHub file write failed (${fileWrite.status})`
      });
    }

    const registryPath = 'registry.json';
    const registryFile = await getFile(registryPath);

    let registry = {
      registry_version: '1.0',
      generated_at: now.toISOString(),
      agents: []
    };

    let registrySha;

    if (registryFile) {
      registry = JSON.parse(
        Buffer.from(registryFile.content, 'base64').toString()
      );
      registrySha = registryFile.sha;
    }

    registry.agents = registry.agents.filter((a) => a.agent_id !== agentId);

    registry.agents.push({
      agent_id: agentId,
      agent_name: manifest.agent_name,
      manifest_url: `https://raw.githubusercontent.com/${GITHUB_OWNER}/${DATASET_REPO}/main/${filePath}`,
      registered_at: now.toISOString()
    });

    registry.generated_at = now.toISOString();

    const registryWrite = await putFile(
      registryPath,
      registry,
      `Update registry: ${agentId}`,
      registrySha
    );

    if (![200, 201].includes(registryWrite.status)) {
      return res.status(500).json({
        status: 'error',
        message: `GitHub registry update failed (${registryWrite.status})`
      });
    }

    return res.status(200).json({
      status: 'accepted',
      agent_id: agentId,
      stored_at: filePath,
      registry_updated: true
    });
  } catch (err) {
    return res.status(500).json({
      status: 'error',
      message: err.message
    });
  }
}
