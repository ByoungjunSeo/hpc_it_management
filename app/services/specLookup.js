const http = require('http');
const https = require('https');

const OLLAMA_HOST = process.env.OLLAMA_HOST || '127.0.0.1';
const OLLAMA_PORT = parseInt(process.env.OLLAMA_PORT || '11434', 10);
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:14b';

/**
 * Query Ollama API (non-streaming)
 * @param {string} prompt - User prompt
 * @returns {Promise<string>} - Model response text
 */
function queryOllama(prompt) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [
        { role: 'system', content: '당신은 IT 하드웨어 스펙 전문가입니다. 반드시 요청된 JSON 형식만 출력하세요. 설명이나 마크다운 없이 순수 JSON만 출력하세요.' },
        { role: 'user', content: prompt }
      ],
      stream: false
    });

    const req = http.request({
      hostname: OLLAMA_HOST,
      port: OLLAMA_PORT,
      path: '/api/chat',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 30000
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.message && parsed.message.content) {
            resolve(parsed.message.content);
          } else {
            reject(new Error('Ollama 응답에 content가 없습니다.'));
          }
        } catch (e) {
          reject(new Error('Ollama 응답 파싱 실패: ' + e.message));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Ollama 요청 타임아웃 (30초)'));
    });

    req.on('error', (err) => {
      reject(new Error('Ollama 연결 실패: ' + err.message));
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Search DuckDuckGo HTML and extract top results
 * @param {string} query - Search query
 * @returns {Promise<string>} - Concatenated search results text
 */
function webSearch(query) {
  return new Promise((resolve, reject) => {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;

    const req = https.request(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 15000
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          // Extract result titles and snippets using regex
          const results = [];
          // Match result links with class "result__a"
          const titleRegex = /<a[^>]*class="result__a"[^>]*>([^<]*(?:<[^>]*>[^<]*)*)<\/a>/gi;
          const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

          let titleMatch;
          const titles = [];
          while ((titleMatch = titleRegex.exec(data)) !== null && titles.length < 5) {
            titles.push(titleMatch[1].replace(/<[^>]*>/g, '').trim());
          }

          let snippetMatch;
          const snippets = [];
          while ((snippetMatch = snippetRegex.exec(data)) !== null && snippets.length < 5) {
            snippets.push(snippetMatch[1].replace(/<[^>]*>/g, '').trim());
          }

          for (let i = 0; i < Math.max(titles.length, snippets.length); i++) {
            const title = titles[i] || '';
            const snippet = snippets[i] || '';
            if (title || snippet) {
              results.push((title ? title + ': ' : '') + snippet);
            }
          }

          resolve(results.length > 0 ? results.join('\n\n') : '검색 결과 없음');
        } catch (e) {
          resolve('검색 결과 파싱 실패');
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve('웹 검색 타임아웃');
    });

    req.on('error', () => {
      resolve('웹 검색 실패');
    });

    req.end();
  });
}

/**
 * Parse JSON from Ollama response (handles markdown code blocks)
 * @param {string} text - Raw Ollama response
 * @returns {object|null} - Parsed JSON or null
 */
function parseJsonResponse(text) {
  // Try direct parse
  try {
    return JSON.parse(text.trim());
  } catch (e) {
    // ignore
  }

  // Try extracting from markdown code block
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch (e) {
      // ignore
    }
  }

  // Try finding JSON object pattern
  const jsonMatch = text.match(/\{[\s\S]*"confidence"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (e) {
      // ignore
    }
  }

  return null;
}

/**
 * Build the spec lookup prompt
 */
function buildPrompt(moduleType, model, manufacturer, capacity, webContext) {
  let prompt = `아래 하드웨어 부품의 상세 스펙을 JSON으로 답변해주세요.

부품 유형: ${moduleType || '알 수 없음'}
모델명: ${model || '알 수 없음'}`;

  if (manufacturer) prompt += `\n제조사(참고): ${manufacturer}`;
  if (capacity) prompt += `\n용량(참고): ${capacity}`;

  if (webContext) {
    prompt += `\n\n참고할 웹 검색 결과:\n${webContext}`;
  }

  prompt += `\n\n반드시 아래 JSON 형식만 출력하세요 (설명 없이 JSON만):
{
  "manufacturer": "정식 제조사명",
  "model_full": "정식 모델명",
  "capacity": "용량/속도 (예: 32GB, 3.2TB, 400GbE)",
  "specification": "DDR5-4800, PCIe 4.0 x4 NVMe 등 핵심 사양",
  "label": "관리용 라벨 (예: Samsung PM9A3 3.84TB)",
  "confidence": 0.0
}

confidence는 0.0~1.0 사이 값으로 답변의 확신도를 나타냅니다.
모르는 항목은 빈 문자열로, confidence를 낮게 설정하세요.`;

  return prompt;
}

/**
 * Main spec lookup function
 * 1. Query Ollama with model name
 * 2. If confidence < 0.7, search web and re-query with context
 * @param {object} params - { module_type, model, manufacturer, capacity }
 * @returns {Promise<object>} - Spec result
 */
async function lookupSpec({ module_type, model, manufacturer, capacity }) {
  if (!model) {
    return { error: '모델명이 필요합니다.', confidence: 0 };
  }

  // Step 1: Query Ollama directly
  const prompt1 = buildPrompt(module_type, model, manufacturer, capacity);
  let response1;
  try {
    response1 = await queryOllama(prompt1);
  } catch (err) {
    return { error: 'AI 조회 실패: ' + err.message, confidence: 0, source: 'error' };
  }

  let result = parseJsonResponse(response1);

  // Step 2: If low confidence or parse failure, try web search + re-query
  if (!result || (typeof result.confidence === 'number' && result.confidence < 0.7)) {
    const searchQuery = `${model} ${manufacturer || ''} ${module_type || ''} specs specifications datasheet`.trim();
    let webResults;
    try {
      webResults = await webSearch(searchQuery);
    } catch (e) {
      webResults = '';
    }

    if (webResults && webResults !== '검색 결과 없음' && webResults !== '웹 검색 실패') {
      const prompt2 = buildPrompt(module_type, model, manufacturer, capacity, webResults);
      try {
        const response2 = await queryOllama(prompt2);
        const result2 = parseJsonResponse(response2);
        if (result2) {
          result2.source = 'ai+web';
          return result2;
        }
      } catch (e) {
        // Fall through to return first result
      }
    }
  }

  if (result) {
    if (!result.source) result.source = 'ai';
    return result;
  }

  return {
    manufacturer: manufacturer || '',
    model_full: model || '',
    capacity: capacity || '',
    specification: '',
    label: '',
    confidence: 0,
    source: 'error',
    error: 'AI 응답을 파싱할 수 없습니다.'
  };
}

module.exports = { lookupSpec, queryOllama, webSearch };
