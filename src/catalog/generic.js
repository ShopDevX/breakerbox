import { binaryName, matches, estimate } from './helpers.js';

/** Hosts whose APIs bill per request. Matched against curl/wget/http targets. */
const PAID_API_HOSTS = [
  { pattern: /api\.openai\.com/i, label: 'OpenAI API', unit: 0.02 },
  { pattern: /api\.anthropic\.com/i, label: 'Anthropic API', unit: 0.02 },
  { pattern: /generativelanguage\.googleapis\.com/i, label: 'Google Gemini API', unit: 0.01 },
  { pattern: /api\.replicate\.com/i, label: 'Replicate API', unit: 0.05 },
  { pattern: /api\.together\.xyz/i, label: 'Together API', unit: 0.01 },
  { pattern: /api\.stripe\.com/i, label: 'Stripe API', unit: 0 },
  { pattern: /api\.twilio\.com|api\.sendgrid\.com/i, label: 'Twilio/SendGrid API', unit: 0.01 },
  { pattern: /serpapi\.com|api\.scraperapi\.com|api\.firecrawl\.dev/i, label: 'Scraping API', unit: 0.01 },
];

export const genericRules = [
  {
    id: 'generic.http.paid-api',
    test: (argv) => {
      const bin = binaryName(argv[0]);
      if (!['curl', 'wget', 'http', 'https', 'xh'].includes(bin)) return false;
      return argv.some((t) => PAID_API_HOSTS.some((h) => h.pattern.test(t)));
    },
    build: (argv) => {
      const hit = PAID_API_HOSTS.find((h) => argv.some((t) => h.pattern.test(t)));
      return estimate({
        ruleId: 'generic.http.paid-api',
        provider: 'http',
        label: hit ? hit.label : 'Metered HTTP API',
        risk: 'low',
        oneTime: hit ? hit.unit : 0.01,
        confidence: 'low',
        note: 'Per-request cost is a nominal placeholder; the value here is counting calls, not pricing them.',
      });
    },
  },
  {
    id: 'generic.docker.run-gpu',
    test: (argv) => matches(argv, ['docker', 'run'])
      && argv.some((t) => t === '--gpus' || t.startsWith('--gpus=')),
    build: () => estimate({
      ruleId: 'generic.docker.run-gpu',
      provider: 'local',
      label: 'GPU container',
      risk: 'medium',
      hourly: 0,
      confidence: 'high',
      note: 'Free locally, but billable on a rented GPU host.',
    }),
  },
  {
    id: 'generic.fly.scale',
    test: (argv) => matches(argv, ['fly', 'scale']) || matches(argv, ['flyctl', 'scale'])
      || matches(argv, ['fly', 'machine', 'run']),
    build: () => estimate({
      ruleId: 'generic.fly.scale',
      provider: 'fly',
      label: 'Fly.io machine scale',
      risk: 'medium',
      hourly: 0.02,
      confidence: 'low',
    }),
  },
  {
    id: 'generic.railway.render',
    test: (argv) => matches(argv, ['railway', 'up']) || matches(argv, ['render', 'deploys', 'create'])
      || matches(argv, ['heroku', 'ps:scale']),
    build: () => estimate({
      ruleId: 'generic.railway.render',
      provider: 'paas',
      label: 'PaaS deploy/scale',
      risk: 'low',
      hourly: 0.01,
      confidence: 'low',
    }),
  },
  {
    id: 'generic.vast.runpod',
    test: (argv) => ['vastai', 'vast', 'runpodctl'].includes(binaryName(argv[0]))
      && argv.some((t) => ['create', 'start'].includes(t)),
    build: () => estimate({
      ruleId: 'generic.vast.runpod',
      provider: 'gpu-cloud',
      label: 'Rented GPU instance',
      risk: 'high',
      hourly: 2.0,
      confidence: 'low',
    }),
  },
];
