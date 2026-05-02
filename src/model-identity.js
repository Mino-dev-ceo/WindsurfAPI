const PROVIDER_KEYS = {
  claude: 'Anthropic',
  gpt: 'OpenAI',
  gemini: 'Google',
  deepseek: 'DeepSeek',
  grok: 'xAI',
  qwen: 'Alibaba',
  kimi: 'Moonshot',
  glm: 'Zhipu',
  swe: 'Windsurf',
  o3: 'OpenAI',
  o4: 'OpenAI',
};

const TOKEN_LABELS = {
  claude: 'Claude',
  gpt: 'GPT',
  gemini: 'Gemini',
  deepseek: 'DeepSeek',
  grok: 'Grok',
  qwen: 'Qwen',
  kimi: 'Kimi',
  glm: 'GLM',
  swe: 'SWE',
  o3: 'o3',
  o4: 'o4',
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  thinking: 'Thinking',
  fast: 'Fast',
  mini: 'Mini',
  codex: 'Codex',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  none: 'None',
  adaptive: 'Adaptive',
  arena: 'Arena',
  smart: 'Smart',
  maxim: 'Maxim',
};

function mergeVersionTokens(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const cur = tokens[i];
    const next = tokens[i + 1];
    if (/^\d+$/.test(cur) && /^\d+$/.test(next)) {
      out.push(`${cur}.${next}`);
      i++;
      continue;
    }
    out.push(cur);
  }
  return out;
}

function prettyToken(token) {
  if (!token) return '';
  if (TOKEN_LABELS[token]) return TOKEN_LABELS[token];
  if (/^\d+(?:\.\d+)?$/.test(token)) return token;
  return token.charAt(0).toUpperCase() + token.slice(1);
}

export function providerForModelName(modelName) {
  const lower = String(modelName || '').toLowerCase();
  const key = Object.keys(PROVIDER_KEYS).find((k) => lower.startsWith(k));
  return key ? PROVIDER_KEYS[key] : '';
}

export function humanizeModelName(modelName) {
  let raw = String(modelName || '').trim();
  if (!raw) return raw;
  if (/^MODEL_/i.test(raw)) {
    raw = raw.replace(/^MODEL_/i, '').replace(/_/g, '-').toLowerCase();
  }

  const tokens = mergeVersionTokens(raw.toLowerCase().split(/[-\s]+/).filter(Boolean));
  if (!tokens.length) return raw;

  if (tokens[0] === 'gpt' && tokens[1]) {
    const rest = tokens.slice(2).map(prettyToken).join(' ');
    return `GPT-${tokens[1]}${rest ? ` ${rest}` : ''}`;
  }

  if (tokens[0] === 'claude') {
    return ['Claude', ...tokens.slice(1).map(prettyToken)].join(' ');
  }

  if ((tokens[0] === 'o3' || tokens[0] === 'o4') && tokens[1]) {
    return [prettyToken(tokens[0]), ...tokens.slice(1).map(prettyToken)].join(' ');
  }

  return tokens.map(prettyToken).join(' ');
}
