/*
  serve.js — 로컬 확인용 간단 정적 서버 (개발 편의용)
  ─────────────────────────────────────────────────────────
  · 실행: node serve.js   →  http://127.0.0.1:8000 접속
  · index.html 이 data.json 을 fetch 로 읽으므로, file:// 더블클릭 대신
    이 서버로 열어야 실제 법제처 데이터가 로드된다.
  · Node 내장 모듈만 사용(의존성 없음). Ctrl+C 로 종료.
*/
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;          // 이 파일이 있는 폴더(=프로젝트 루트)를 서빙
const PORT = 8000;

// 확장자별 MIME 타입
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
};

const server = http.createServer(function (req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  // 경로 이탈(../) 방지 — ROOT 뒤에 구분자를 붙여 형제 폴더(my-app-secret 등) 접두어 우회 차단
  const filePath = path.join(ROOT, urlPath);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end('forbidden'); return; }

  // 비밀 파일(.env 등)은 서빙하지 않는다
  const base = path.basename(filePath);
  if (base === '.env' || base.indexOf('.env') === 0) { res.writeHead(404); res.end('not found'); return; }

  fs.readFile(filePath, function (err, data) {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', function () {
  console.log('로컬 서버 실행 중 →  http://127.0.0.1:' + PORT + '/');
  console.log('브라우저에서 위 주소를 열어 확인하세요. (종료: Ctrl+C)');
});
