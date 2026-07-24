/*
  build-dist.js — 배포 폴더(dist/) 생성 스크립트 (개발 편의용)
  ─────────────────────────────────────────────────────────
  · 목적: 인터넷 공개 시 dist/ 에는 index.html + data.json "2개만" 담기게 강제한다.
    (폴더 통째 업로드로 .env·fetch-laws.js·.git 등이 유출되는 위험 H-1/H-2 차단 — CHECK.md §4-1)
  · 실행: node build-dist.js
  · 동작: dist/ 를 비운 뒤 허용 목록(ALLOW)에 있는 파일만 복사한다.
    허용 목록 밖의 파일은 애초에 복사하지 않으므로 실수로 비밀 파일이 섞일 수 없다.
  · Node 내장 모듈만 사용(의존성 없음).
*/
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');

// 배포에 포함할 파일 화이트리스트 — 이 2개 외에는 절대 복사하지 않는다.
const ALLOW = ['index.html', 'data.json'];

// 1) dist/ 를 깨끗이 비우고 새로 만든다(낡은 잔재 제거).
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

// 2) 허용 목록의 파일만 복사한다. 원본이 없으면 오류로 알린다.
const copied = [];
for (const name of ALLOW) {
  const src = path.join(ROOT, name);
  if (!fs.existsSync(src)) {
    console.error('[오류] 원본 파일이 없습니다: ' + name + ' — 먼저 생성/갱신하세요.');
    process.exit(1);
  }
  fs.copyFileSync(src, path.join(DIST, name));
  const kb = (fs.statSync(src).size / 1024).toFixed(1);
  copied.push(name + ' (' + kb + ' KB)');
}

// 3) 결과 요약 출력.
console.log('배포 폴더 생성 완료 → ' + DIST);
copied.forEach(function (line) { console.log('  · ' + line); });
console.log('\n이 dist/ 폴더의 내용만 호스트에 올리세요. (그 외 파일은 배포 금지)');
