'use strict';
const http = require('node:http');

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const DEFAULT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
const MAX_BODY_BYTES = 1024 * 1024;

function json(response, status, value, headers = {}) {
  response.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers});
  response.end(JSON.stringify(value));
}

function accepted(response) {
  response.writeHead(202, {'Cache-Control': 'no-store'});
  response.end();
}

function rpcResult(id, result) {
  return {jsonrpc: '2.0', id, result};
}

function rpcError(id, code, message, data) {
  return {jsonrpc: '2.0', id: id ?? null, error: {code, message, ...(data === undefined ? {} : {data})}};
}

function isLoopback(address) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
}

function isTailnet(address) {
  const value = address?.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  const parts = typeof value === 'string' ? value.split('.').map(Number) : [];
  return parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255) &&
    parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

function allowedRemote(address) {
  return isLoopback(address) || (process.env.MCP_ALLOW_TAILNET === '1' && isTailnet(address));
}

function validOrigin(origin) {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

async function readJSON(request) {
  let size = 0;
  const parts = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(Error('Request too large'), {status: 413});
    parts.push(chunk);
  }
  if (parts.length === 0) throw Object.assign(Error('Missing JSON-RPC body'), {status: 400});
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

async function controlFetch(baseUrl, route, {method = 'GET', body} = {}) {
  const response = await fetch(new URL(route, baseUrl), {
    method,
    headers: {'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(90000)
  });
  const text = await response.text();
  let value = null;
  if (text) {
    try { value = JSON.parse(text); }
    catch { value = {error: text}; }
  }
  if (!response.ok) {
    const error = Error(value?.error || `Control server returned HTTP ${response.status}`);
    error.status = response.status;
    error.details = value;
    throw error;
  }
  return value;
}

function toolResultText(value) {
  return JSON.stringify(value, null, 2);
}

const pointSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    x: {type: 'number'},
    y: {type: 'number'}
  },
  required: ['x', 'y']
};

const pressKeysSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    key: {
      type: 'string',
      description: 'Required. Use one printable character, or one of: enter, return, escape, esc, backspace, tab, space, delete, home, end, pageup, pagedown, right, left, down, up, f1 through f12.'
    },
    modifiers: {
      type: 'array',
      items: {type: 'string', enum: ['ctrl', 'shift', 'alt', 'cmd']},
      default: [],
      description: 'Optional modifier keys held while pressing key. Use cmd for Command on iPadOS.'
    }
  },
  required: ['key'],
  description: 'Object form only. Correct: {"key":"space","modifiers":["cmd"]}. Incorrect: ["cmd","space"] or {"key":["cmd","space"]}.'
};

const actionVariants = [
  {
    type: 'object',
    additionalProperties: false,
    properties: {
      type: {const: 'type_text'},
      text: {type: 'string', description: 'Literal text to type into the focused field.'}
    },
    required: ['type', 'text'],
    description: 'Type literal text.'
  },
  {
    type: 'object',
    additionalProperties: false,
    properties: {
      type: {const: 'press'},
      keys: pressKeysSchema
    },
    required: ['type', 'keys'],
    description: 'Press one key or key chord. Example: {"type":"press","keys":{"key":"space","modifiers":["cmd"]}} for Command-Space.'
  },
  {
    type: 'object',
    additionalProperties: false,
    properties: {
      type: {const: 'wait'},
      ms: {type: 'integer', minimum: 0, maximum: 10000}
    },
    required: ['type', 'ms']
  },
  {
    type: 'object',
    additionalProperties: false,
    properties: {
      type: {const: 'click'},
      x: {type: 'number', description: 'Optional screenshot x coordinate. Requires top-level pointer.'},
      y: {type: 'number', description: 'Optional screenshot y coordinate. Requires top-level pointer.'},
      button: {type: 'string', enum: ['left', 'right', 'middle'], default: 'left'}
    },
    required: ['type'],
    description: 'Click the current pointer position, or move from top-level pointer to x/y then click.'
  },
  {
    type: 'object',
    additionalProperties: false,
    properties: {
      type: {const: 'move_to'},
      x: {type: 'number'},
      y: {type: 'number'}
    },
    required: ['type', 'x', 'y'],
    description: 'Move from top-level/current pointer to screenshot coordinate x/y. Requires top-level pointer for the first absolute pointer action.'
  },
  {
    type: 'object',
    additionalProperties: false,
    properties: {
      type: {const: 'move_by'},
      dx: {type: 'integer', minimum: -4096, maximum: 4096},
      dy: {type: 'integer', minimum: -4096, maximum: 4096}
    },
    required: ['type', 'dx', 'dy'],
    description: 'Move by relative HID counts. Diagnostic use; prefer move_to after calibration.'
  },
  {
    type: 'object',
    additionalProperties: false,
    properties: {
      type: {const: 'drag'},
      from: pointSchema,
      to: pointSchema,
      button: {type: 'string', enum: ['left', 'right', 'middle'], default: 'left'}
    },
    required: ['type', 'from', 'to'],
    description: 'Drag between two screenshot coordinates. Requires pointer calibration.'
  },
  {
    type: 'object',
    additionalProperties: false,
    properties: {
      type: {const: 'scroll'},
      dy: {type: 'integer', minimum: -127, maximum: 127, description: 'Signed USB wheel units, not pixels. On the tested iPad, positive scrolls down and negative scrolls up; device settings can reverse this. Move the pointer over the intended scrollable pane first. Small amounts may barely move. Try 80, wait 500 ms, then get_screen; if unchanged, check the pane, boundary and opposite sign instead of repeating blindly.'}
    },
    required: ['type', 'dy']
  }
];

const actionSchema = {
  type: 'object',
  additionalProperties: false,
  description: 'Send input to the iPad. For key chords, press.keys is always an object: {"key":"space","modifiers":["cmd"]}. Do not send arrays for press.keys.',
  properties: {
    coordinateSpace: {
      type: 'object',
      additionalProperties: false,
      properties: {
        width: {type: 'number', exclusiveMinimum: 0},
        height: {type: 'number', exclusiveMinimum: 0},
        units: {type: 'string'}
      },
      required: ['width', 'height']
    },
    pointer: {
      ...pointSchema,
      description: 'Current known pointer position in coordinateSpace units. Required before the first absolute click or move_to because the hardware mouse only accepts relative movement.'
    },
    delay: {type: 'integer', minimum: 0, maximum: 10},
    actions: {
      type: 'array',
      minItems: 1,
      maxItems: 200,
      items: {oneOf: actionVariants}
    }
  },
  required: ['actions']
};

const tools = [
  {
    name: 'status',
    title: 'iPad Control Status',
    description: 'Return connection, session, calibration, and pending-command status for the iPad control server.',
    inputSchema: {type: 'object', additionalProperties: false},
    annotations: {readOnlyHint: true}
  },
  {
    name: 'get_screen',
    title: 'Get Current iPad Screen',
    description: 'Request a fresh iPad screenshot from the active screen broadcast and return it as a JPEG image.',
    inputSchema: {type: 'object', additionalProperties: false},
    annotations: {readOnlyHint: true}
  },
  {
    name: 'issue_actions',
    title: 'Issue iPad Input Actions',
    description: 'Send ordered keyboard and pointer actions to the iPad. IMPORTANT: press.keys must be an object, for example {"key":"space","modifiers":["cmd"]}; never an array. Coordinates are in the latest screenshot coordinate space; absolute pointer actions require top-level pointer, for example {"coordinateSpace":{"width":1280,"height":960},"pointer":{"x":640,"y":480},"actions":[{"type":"click","x":500,"y":300}]}',
    inputSchema: actionSchema,
    annotations: {readOnlyHint: false, destructiveHint: true}
  }
];

function initializeResult(requestedVersion) {
  const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion) ? requestedVersion : DEFAULT_PROTOCOL_VERSION;
  return {
    protocolVersion,
    capabilities: {tools: {listChanged: false}},
    serverInfo: {name: 'ipad-control-server', title: 'iPad Computer Use', version: '0.1.0'},
    instructions: [
      'Use get_screen to inspect the current iPad screen.',
      'Use issue_actions to send short, ordered keyboard and pointer actions.',
      'For key chords, press.keys is an object: {"key":"space","modifiers":["cmd"]} sends Command-Space. Do not use arrays for press.keys.',
      'Pointer actions use screenshot coordinates and require calibration in the iPad app.',
      'Scroll dy is raw wheel units, not pixels; the tested iPad scrolls down for positive values. Verify direction and movement with get_screen, since settings and the hovered pane affect the result.',
      'Absolute click and move_to require top-level coordinateSpace and pointer because the hardware only supports relative mouse movement.'
    ].join(' ')
  };
}

function createMcpServer({controlBaseUrl = `http://127.0.0.1:${process.env.PORT || 8765}/`} = {}) {
  async function callTool(name, args = {}) {
    if (name === 'status') {
      const result = await controlFetch(controlBaseUrl, '/status');
      return {content: [{type: 'text', text: toolResultText(result)}], structuredContent: result};
    }
    if (name === 'get_screen') {
      const result = await controlFetch(controlBaseUrl, '/screen');
      const {data, ...metadata} = result;
      return {
        content: [
          {type: 'text', text: toolResultText(metadata)},
          {type: 'image', data, mimeType: result.mimeType || 'image/jpeg'}
        ],
        structuredContent: metadata
      };
    }
    if (name === 'issue_actions') {
      const result = await controlFetch(controlBaseUrl, '/computer-use/actions', {method: 'POST', body: args});
      return {content: [{type: 'text', text: toolResultText(result)}], structuredContent: result};
    }
    throw Object.assign(Error('Unknown tool: ' + name), {code: -32602});
  }

  async function handleRpc(message) {
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return rpcError(message?.id, -32600, 'Invalid JSON-RPC request');
    }
    const id = message.id;
    if (id === undefined) return null;
    if (message.method === 'initialize') return rpcResult(id, initializeResult(message.params?.protocolVersion));
    if (message.method === 'ping') return rpcResult(id, {});
    if (message.method === 'tools/list') return rpcResult(id, {tools});
    if (message.method === 'prompts/list') return rpcResult(id, {prompts: []});
    if (message.method === 'resources/list') return rpcResult(id, {resources: []});
    if (message.method === 'tools/call') {
      const name = message.params?.name;
      const args = message.params?.arguments || {};
      if (typeof name !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) {
        return rpcError(id, -32602, 'Invalid tool call parameters');
      }
      try {
        return rpcResult(id, await callTool(name, args));
      } catch (error) {
        if (error.code) return rpcError(id, error.code, error.message);
        return rpcResult(id, {
          content: [{type: 'text', text: error.message}],
          isError: true,
          structuredContent: {error: error.message, status: error.status || null, details: error.details || null}
        });
      }
    }
    return rpcError(id, -32601, 'Method not found: ' + message.method);
  }

  const server = http.createServer(async (request, response) => {
    if (request.url !== '/mcp') {
      json(response, 404, {error: 'Not found'});
      return;
    }
    if (!allowedRemote(request.socket.remoteAddress) || !validOrigin(request.headers.origin)) {
      json(response, 403, rpcError(null, -32000, 'Forbidden'));
      return;
    }
    if (request.method === 'GET') {
      response.writeHead(405, {'Allow': 'POST, DELETE', 'Cache-Control': 'no-store'});
      response.end();
      return;
    }
    if (request.method === 'DELETE') {
      accepted(response);
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405, {'Allow': 'POST, DELETE', 'Cache-Control': 'no-store'});
      response.end();
      return;
    }
    try {
      const message = await readJSON(request);
      if (Array.isArray(message)) {
        json(response, 400, rpcError(null, -32600, 'JSON-RPC batches are not supported'));
        return;
      }
      const result = await handleRpc(message);
      if (!result) {
        accepted(response);
        return;
      }
      json(response, 200, result);
    } catch (error) {
      const status = error.status || (error instanceof SyntaxError ? 400 : 500);
      json(response, status, rpcError(null, status === 400 ? -32700 : -32000, error.message));
    }
  });
  return {server, close: async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }};
}

if (require.main === module) {
  const host = process.env.MCP_HOST || '127.0.0.1';
  const port = Number(process.env.MCP_PORT || 8780);
  const mcp = createMcpServer();
  mcp.server.listen(port, host, () => {
    console.log(`iPad MCP adapter listening on http://${host}:${port}/mcp`);
    console.log('No MCP-layer auth is enabled. Keep access limited to loopback, Secure MCP Tunnel, or a private tailnet.');
  });
  mcp.server.on('error', error => {console.error(error.message); process.exitCode = 1; mcp.close();});
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => mcp.close());
}

module.exports = {createMcpServer, tools};
