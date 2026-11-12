import test from 'node:test';
import assert from 'node:assert/strict';

import { errorHint } from '../../src/bb/http.js';

test('errorHint：权限/找不到/限流/5xx 各给一句可操作的提示', () => {
  assert.equal(errorHint({ status: 401 }), '没有权限读取这个文件，请确认登录状态后重试');
  assert.equal(errorHint({ status: 403 }), '没有权限读取这个文件，请确认登录状态后重试');
  assert.equal(errorHint({ status: 404 }), '服务器上找不到这个文件，可能已被移除');
  assert.equal(errorHint({ status: 429 }), '请求太频繁，已被服务器限流，稍后再试');
  assert.equal(errorHint({ status: 503 }), '学校服务器暂时不可用，稍后重试');
  assert.equal(errorHint({ status: 418 }), '请求失败（HTTP 418）');
});

test('errorHint：网络层错误按类型给提示', () => {
  assert.equal(errorHint({ name: 'StallError' }), '连接长时间没有新数据，可能是网络中断');
  assert.equal(errorHint({ name: 'TruncatedError' }), '文件没有下载完整，已重新排队');
  assert.equal(errorHint({ name: 'TypeError', message: 'Failed to fetch' }), '网络连接中断，检查网络或校园网后重试');
  assert.equal(errorHint({ name: 'Error', message: 'NetworkError when attempting to fetch resource.' }), '网络连接中断，检查网络或校园网后重试');
});

test('errorHint：未知错误返回空串，且任何情况下都不回显 URL', () => {
  assert.equal(errorHint(null), '');
  assert.equal(errorHint({ name: 'Error', message: 'boom' }), '');
  const hinted = errorHint({ status: 500, message: 'see https://bb.example.edu/bbcswebdav/secret.pdf' });
  assert.equal(hinted.includes('http'), false);
  assert.equal(hinted.includes('secret'), false);
});
