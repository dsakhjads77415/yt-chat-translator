// 채팅 은어 사전 + 번역 전처리
// - EXACT: 메시지 전체가 이 표현이면 구글로 보내지 않고 바로 변환
// - TERMS: 번역 전에 문장 속 용어를 한국어로 바꿔서 보냄
// - 문장 끝 ｗｗ/草 는 떼고 번역한 뒤 "ㅋㅋ" 를 붙임
(function (root) {
  const JP_RE = /[぀-ヿㇰ-ㇿｦ-ﾟ㐀-䶿一-鿿]/;
  const KANA_RE = /[぀-ヿㇰ-ㇿｦ-ﾟ]/;
  const HANGUL_RE = /[ᄀ-ᇿ㄰-㆏가-힯]/;
  const KANJI_RE = /[㐀-䶿一-鿿]/;

  const EXACT = {
    // 인사
    'おつ': '수고하셨어요', '乙': '수고하셨어요', 'おつおつ': '수고하셨어요', 'おつでした': '수고하셨어요',
    'おつかれ': '수고하셨어요', 'おつかれさま': '수고하셨어요', 'おつかれさまでした': '수고하셨어요',
    'お疲れ': '수고하셨어요', 'お疲れさま': '수고하셨어요', 'お疲れ様': '수고하셨어요',
    'お疲れさまでした': '수고하셨어요', 'お疲れ様でした': '수고하셨어요',
    'おつです': '수고하세요', 'おつかれさまです': '수고하세요', 'お疲れさまです': '수고하세요', 'お疲れ様です': '수고하세요',
    'うぽつ': '방송 고마워요',
    '初見': '처음 왔어요', '初見です': '처음 왔어요', '初見さん': '처음 오신 분',
    '初見さんいらっしゃい': '처음 오신 분 어서 오세요',
    'おかえり': '어서 와요', 'おかえりなさい': '어서 와요', 'ただいま': '다녀왔어요',
    'いってらっしゃい': '다녀오세요', 'いってきます': '다녀올게요',
    // 리액션
    'てぇてぇ': '존귀해', 'てぇてぇなぁ': '존귀해', 'てえてえ': '존귀해',
    'かわいい': '귀여워', 'かわよ': '귀여워', 'かわ': '귀여워', 'きゃわ': '귀여워', 'きゃわわ': '귀여워', 'かわいすぎ': '너무 귀여워',
    'やば': '대박', 'やばい': '대박', 'ヤバ': '대박', 'ヤバい': '대박', 'やばすぎ': '대박이다', 'ヤバすぎ': '대박이다',
    'えぐ': '미쳤다', 'えぐい': '미쳤다', 'エグ': '미쳤다', 'エグい': '미쳤다',
    'ナイス': '나이스', 'ないす': '나이스',
    '神': '갓', '神回': '레전드 회차', '神すぎ': '갓갓',
    'それな': '그니까', 'わかる': '인정', 'わかりみ': '인정',
    'それは草': '그건 웃기네 ㅋㅋ',
    'ドンマイ': '괜찮아요 힘내요',
    'あざす': '감사', 'あざっす': '감사', 'あざまる': '감사',
    'りょ': 'ㅇㅋ', 'りょうかい': '알겠어요', '了解': '알겠어요', 'おけ': 'ㅇㅋ', 'おけまる': 'ㅇㅋ',
    'ガチ': '진짜로', 'ワンチャン': '가능성 있다',
  };

  // 메시지 전체가 패턴과 일치할 때
  const EXACT_PATTERNS = [
    [/^(w+|草+|大草原|くさ|ワロタ|わろた|\(笑\)|笑)+$/, 'ㅋㅋㅋ'],
    [/^8{3,}$/, '짝짝짝'],
    [/^(おつ)+$/, '수고하셨어요'],
    [/^(き|キ)(た|タ)(あ|ア|ぁ|ァ)*$/, '왔다!'],
  ];

  // 번역 전에 문장 속에서 바꿔 넣는 용어 (긴 것부터 적용)
  const TERMS = {
    '配信': '방송',
    '鯖': '서버',
    '赤スパ': '빨간 슈퍼챗',
    'スパチャ': '슈퍼챗',
    'メン限': '멤버십 한정',
    'メンシ': '멤버십',
    '同接': '동시 시청자',
    '推し': '최애',
    '初見さん': '처음 오신 분',
    'リスナー': '시청자',
    'ガチャ': '가챠',
    'てぇてぇ': '존귀',
    'マビノギモバイル': '마비노기 모바일',
    'マビモバ': '마비노기 모바일',
    'マビノギ': '마비노기',

    // 마비노기 모바일 클래스 (일본판 표기 → 한국판 표기, 계열별 1:1 대응)
    '見習い戦士': '견습 전사', '大剣戦士': '대검전사', '剣術士': '검술사', '騎士': '기사', '戦士': '전사',
    '見習い弓使い': '견습 궁수', 'クロスボウ使い': '석궁사수', 'ロングボウ使い': '장궁병', '弓使い': '궁수',
    '見習い魔法使い': '견습 마법사', '火炎術師': '화염술사', '炎術師': '화염술사', '氷結術師': '빙결술사',
    '電撃術師': '전격술사', '魔法使い': '마법사',
    '見習いヒーラー': '견습 힐러', '司祭': '사제', '修道士': '수도사', '暗黒術師': '암흑술사', 'ヒーラー': '힐러',
    '見習い吟遊詩人': '견습 음유시인', '吟遊詩人': '음유시인', '楽師': '악사', 'ダンサー': '댄서',
    '見習い盗賊': '견습 도적', '格闘家': '격투가', 'デュアルブレイド': '듀얼블레이드', '盗賊': '도적',
    // 지명·시스템 (일본 서버 이름 = 지명)
    'ティルコネイル': '티르코네일', 'ダンバートン': '던바튼', 'トゥガルドアイル': '두갈드아일',
    'エンブレム': '엠블럼', 'アビス': '어비스', '転職': '전직',
  };

  function norm(s) {
    return s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  }
  function stripPunct(s) {
    return s.replace(/[!?！？。、.,~〜ー…・♪☆★♡❤\s]+$/u, '').trim();
  }

  // "원문=번역" 줄 목록 → {원문(정규화): 번역}
  function parseUserDict(textBlock) {
    const map = {};
    for (const line of String(textBlock || '').split(/\r?\n/)) {
      const i = line.indexOf('=');
      if (i <= 0) continue;
      const k = norm(line.slice(0, i));
      const v = line.slice(i + 1).trim();
      if (k && v) map[k] = v;
    }
    return map;
  }

  // 문장 끝 웃음(ｗｗ, 草, (笑)) 떼기
  function splitLaughSuffix(s) {
    let body = s;
    let found = false;
    for (;;) {
      const t = body.replace(/[!?！？\s]+$/, '');
      let m;
      if ((m = t.match(/w+$/))) {
        const prev = t.slice(0, t.length - m[0].length).slice(-1);
        if (prev && /[a-z0-9]/i.test(prev)) break; // 영어 단어 끝의 w
        body = t.slice(0, t.length - m[0].length);
      } else if ((m = t.match(/草+$/))) {
        const prev = t.slice(0, t.length - m[0].length).slice(-1);
        if (prev && KANJI_RE.test(prev)) break; // 雑草 같은 단어
        body = t.slice(0, t.length - m[0].length);
      } else if ((m = t.match(/(\(笑\)|ワロタ)$/))) {
        body = t.slice(0, t.length - m[0].length);
      } else break;
      found = true;
    }
    return found ? { body: body.trim(), suffix: 'ㅋㅋ' } : { body: s, suffix: '' };
  }

  function applyTerms(s, userMap) {
    const all = Object.assign({}, TERMS, userMap);
    const keys = Object.keys(all).sort((a, b) => b.length - a.length);
    let out = s;
    for (const k of keys) {
      if (k && out.includes(k)) out = out.split(k).join(all[k]);
    }
    return out;
  }

  // 번역 대상인지
  function needsTranslation(text, otherLangs) {
    if (!text) return false;
    if (KANA_RE.test(text)) return true;
    if (HANGUL_RE.test(text)) return false;
    if (JP_RE.test(text)) return true; // 한자만 있는 메시지 (草, 神 등)
    if (otherLangs) return /[a-z]{2,}/i.test(text) || /[^\u0000-ɏ\s\p{P}\p{S}\p{N}]/u.test(text);
    return false;
  }

  // 반환: { local: 바로 쓸 번역 | null, send: 구글로 보낼 문장, raw: AI로 보낼 문장, suffix: 웃음 꼬리, codes: 이모티콘 코드, sl }
  // :sparkles: 같은 이모티콘 코드는 번역에서 빼고 끝에 그대로 붙임
  function prepare(text, userMap) {
    const codes = (text.match(/:[a-z0-9_+\-]+:/gi) || []).join(' ');
    const core = codes ? text.replace(/:[a-z0-9_+\-]+:/gi, ' ').replace(/\s+/g, ' ').trim() : text;
    const p = core ? prepareCore(core, userMap) : { local: codes };
    p.codes = p.local === codes ? '' : codes;
    if (p.local && p.codes) p.local += ' ' + p.codes;
    if (!p.local) p.raw = core.normalize('NFKC');
    return p;
  }

  function prepareCore(text, userMap) {
    userMap = userMap || {};
    const n = norm(text);
    const key = stripPunct(n);
    if (userMap[key]) return { local: userMap[key] };
    if (EXACT[key]) return { local: EXACT[key] };
    for (const [re, val] of EXACT_PATTERNS) if (re.test(key)) return { local: val };

    const { body, suffix } = splitLaughSuffix(text.normalize('NFKC').trim());
    const bkey = stripPunct(norm(body));
    const join = (s) => (suffix ? s + ' ' + suffix : s);
    if (userMap[bkey]) return { local: join(userMap[bkey]) };
    if (EXACT[bkey]) return { local: join(EXACT[bkey]) };

    const replaced = applyTerms(body, userMap);
    if (!JP_RE.test(replaced) && HANGUL_RE.test(replaced)) return { local: join(replaced) };
    return { local: null, send: replaced, suffix, sl: KANA_RE.test(replaced) ? 'ja' : 'auto' };
  }

  root.YTCT_DICT = { prepare, needsTranslation, parseUserDict, norm, EXACT, TERMS, JP_RE };
})(typeof globalThis !== 'undefined' ? globalThis : this);
