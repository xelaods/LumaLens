'use strict';
const { endpointUrl, buildMessages, parseTranslations } = require('./core.cjs');
async function request(url, init, signal) {
  let response;
  try { response = await fetch(url, { ...init, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(15000), redirect: 'error' }); }
  catch(error) {
    if(error.name === 'AbortError' || error.name === 'TimeoutError')throw error;
    throw new Error('翻訳サービスに接続できません。Ollamaの起動状態、接続先URL、ネットワークを確認してください。');
  }
  if (!response.ok) {
    const hint = response.status === 401 ? 'APIキーを確認してください。' : response.status === 404 ? '接続先とモデル名を確認してください。' : response.status === 429 ? '利用制限に達しました。少し待って再試行してください。' : 'サービスの稼働状態を確認してください。';
    throw new Error(`翻訳サービスへの接続に失敗しました (${response.status})。${hint}`);
  }
  return response.json();
}
function headers(key) { return { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }; }
async function models(settings, key) {
  const base = endpointUrl(settings.endpoint, settings.provider);
  const data = await request(`${base}${settings.provider === 'ollama' ? '/api/tags' : '/models'}`, { headers: headers(key) });
  return (settings.provider === 'ollama' ? data.models?.map(m => m.name) : data.data?.map(m => m.id))?.filter(m => typeof m === 'string').sort() || [];
}
async function translate(regions, settings, key, previous, signal) {
  if (!settings.model) throw new Error('設定で翻訳モデルを選択してください。');
  const base = endpointUrl(settings.endpoint, settings.provider);
  const messages = buildMessages(regions, settings, previous);
  const body = settings.provider === 'ollama' ? { model: settings.model, messages, stream: false, format: 'json', options: { temperature: .2 } } : { model: settings.model, messages, response_format: { type: 'json_object' } };
  const data = await request(`${base}${settings.provider === 'ollama' ? '/api/chat' : '/chat/completions'}`, { method: 'POST', headers: headers(key), body: JSON.stringify(body) }, signal);
  const text = settings.provider === 'ollama' ? data.message?.content : data.choices?.[0]?.message?.content;
  if (typeof text !== 'string') throw new Error('翻訳サービスの応答を読み取れませんでした。');
  return parseTranslations(text, regions);
}
module.exports = { models, translate };
