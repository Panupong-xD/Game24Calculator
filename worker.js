// Import WebAssembly math module
importScripts('./wasm-math.js');

// Core variables
let operatorFlags = {};
let useIntegerMode = false;
let MAX_SQRT_DEPTH = 2;
let MAX_FACT_DEPTH = 1;
let MAX_FACTORIAL_INPUT = 10;
let MAX_RESULTS = 100;
let speedAccuracy = 0.6; // 0 = fastest, 1 = most accurate
const EXACT_EPS = 1e-12;
let lastTimedOut = false; // NEW: indicate dfs fast phase stopped by time budget

const factorialCache = new Map();
const calculationCache = new Map();
const expressionCache = new Map();
// Operation cache for dfs (binary op results) to reduce recomputation
const opResultCache = new Map();

function factorial(n) {
  if (n < 0 || n > MAX_FACTORIAL_INPUT || !Number.isInteger(n)) return NaN;
  if (n === 0 || n === 1) return 1;
  if (factorialCache.has(n)) return factorialCache.get(n);
  let result;
  if (self.wasmMath && self.wasmMath.isReady) {
    result = self.wasmMath.factorial(n);
  } else {
    result = 1; for (let i=2;i<=n;i++) result*=i;
  }
  factorialCache.set(n,result);
  return result;
}

function evaluateAST(node) {
  if (node.type === 'num') return node.value;
  if (node.value !== undefined) return node.value; // cached value on op node
  let leftVal = node.left ? evaluateAST(node.left) : null;
  let rightVal = evaluateAST(node.right);
  const cacheKey = `${node.operator}|${leftVal}|${rightVal}`;
  if (calculationCache.has(cacheKey)) return calculationCache.get(cacheKey);
  let result;
  if (self.wasmMath && self.wasmMath.isReady) {
    switch(node.operator){
      case '+': result = operatorFlags['+'] ? self.wasmMath.add(leftVal,rightVal) : NaN; break;
      case '-': result = operatorFlags['-'] ? self.wasmMath.sub(leftVal,rightVal) : NaN; break;
      case '*': result = operatorFlags['*'] ? self.wasmMath.mul(leftVal,rightVal) : NaN; break;
      case '/': result = operatorFlags['/'] && rightVal!==0 ? self.wasmMath.div(leftVal,rightVal) : NaN; break;
      case '%': if (!operatorFlags['%']|| rightVal===0) return NaN; result = leftVal - rightVal * Math.floor(leftVal/rightVal); break;
      case '^': if(!operatorFlags['^']) return NaN; result = (leftVal===0 && rightVal<=0)?(rightVal===0?1:NaN): self.wasmMath.pow(leftVal,rightVal); break;
      case '√': result = operatorFlags['√'] && rightVal>=0 ? self.wasmMath.sqrt(rightVal): NaN; break;
      case '!': result = operatorFlags['!'] && rightVal<=MAX_FACTORIAL_INPUT && rightVal>=0 && Number.isInteger(rightVal)? self.wasmMath.factorial(rightVal): NaN; break;
      default: return NaN;
    }
  } else {
    switch(node.operator){
      case '+': result = operatorFlags['+'] ? leftVal+rightVal : NaN; break;
      case '-': result = operatorFlags['-'] ? leftVal-rightVal : NaN; break;
      case '*': result = operatorFlags['*'] ? leftVal*rightVal : NaN; break;
      case '/': result = operatorFlags['/'] && rightVal!==0 ? leftVal/rightVal : NaN; break;
      case '%': if(!operatorFlags['%']|| rightVal===0) return NaN; result = leftVal - rightVal * Math.floor(leftVal/rightVal); break;
      case '^': if(!operatorFlags['^']) return NaN; result = (leftVal===0 && rightVal<=0)?(rightVal===0?1:NaN): Math.pow(leftVal,rightVal); break;
      case '√': result = operatorFlags['√'] && rightVal>=0 ? Math.sqrt(rightVal): NaN; break;
      case '!': result = operatorFlags['!'] && rightVal<=MAX_FACTORIAL_INPUT && rightVal>=0 && Number.isInteger(rightVal)? factorial(rightVal): NaN; break;
      default: return NaN;
    }
  }
  if (!isNaN(result)) {
    if (calculationCache.size>1000000) calculationCache.clear();
    calculationCache.set(cacheKey,result);
    node.value = result; // persist
  }
  return result;
}

function isIntegerResult(r){ return Number.isInteger(r) || Math.abs(r - Math.round(r)) < 0.0001; }
function serializeAST(node){ if(node.type==='num') return node.value.toString(); if(node.operator==='√') return `√(${serializeAST(node.right)})`; if(node.operator==='!') return `(${serializeAST(node.right)})!`; return `(${node.left?serializeAST(node.left):''} ${node.operator} ${serializeAST(node.right)})`; }
function canonicalizeAST(node){ if(node.type==='num') return node; let left=node.left?canonicalizeAST(node.left):null; let right=canonicalizeAST(node.right); if(node.operator==='+'||node.operator==='*'||node.operator==='%'){ let ls=serializeAST(left), rs=serializeAST(right); if(ls>rs) return {type:'op',operator:node.operator,left:right,right:left,value:node.value}; } return {type:'op',operator:node.operator,left,right,value:node.value}; }
function getSqrtDepth(n){ if(n.type==='num') return 0; if(n.operator==='√') return 1+getSqrtDepth(n.right); let ld=n.left?getSqrtDepth(n.left):0; let rd=n.right?getSqrtDepth(n.right):0; return Math.max(ld,rd);} 
function getFactDepth(n){ if(n.type==='num') return 0; if(n.operator==='!') return 1+getFactDepth(n.right); let ld=n.left?getFactDepth(n.left):0; let rd=n.right?getFactDepth(n.right):0; return Math.max(ld,rd);} 

function generateAllGroupings(nums,target){
  const memo=new Map();
  function helper(start,end){
    const key=`${start}-${end}`; if(memo.has(key)) return memo.get(key);
    const res=[];
    if(start===end){
      const numNode={type:'num',value:nums[start]}; res.push(numNode);
      if(operatorFlags['√'] && nums[start]>=0 && (!useIntegerMode|| Number.isInteger(Math.sqrt(nums[start])))){
        let cur=numNode; for(let i=1;i<=MAX_SQRT_DEPTH && operatorFlags['√'];i++){ cur={type:'op',operator:'√',left:null,right:cur}; const v=evaluateAST(cur); if(!isNaN(v) && (!useIntegerMode||isIntegerResult(v))) res.push(cur);} }
      if(operatorFlags['!'] && nums[start]>=0 && nums[start] <= MAX_FACTORIAL_INPUT && Number.isInteger(nums[start])){ let cur=numNode; for(let i=1;i<=MAX_FACT_DEPTH && operatorFlags['!']; i++){ cur={type:'op',operator:'!',left:null,right:cur}; const v=evaluateAST(cur); if(!isNaN(v)) res.push(cur);} }
    } else {
      for(let i=start;i<end;i++){
        const leftExprs=helper(start,i); const rightExprs=helper(i+1,end);
        if(!Array.isArray(leftExprs)||!Array.isArray(rightExprs)) continue;
        for(const left of leftExprs){
          const leftVal = evaluateAST(left); if(isNaN(leftVal)) continue;
            for(const right of rightExprs){
            const rightVal = evaluateAST(right); if(isNaN(rightVal)) continue;
            const ops=[]; if(operatorFlags['+']) ops.push('+'); if(operatorFlags['-']) ops.push('-'); if(operatorFlags['*']) ops.push('*'); if(operatorFlags['/']) ops.push('/'); if(operatorFlags['%']) ops.push('%'); if(operatorFlags['^']) ops.push('^');
            for(const op of ops){
              if(op==='/' && rightVal===0) continue;
              if(op==='%' && rightVal===0) continue;
              if(op==='^' && leftVal===0 && rightVal<=0) continue;
              let resultVal;
              switch(op){
                case '+': resultVal = leftVal + rightVal; break;
                case '-': resultVal = leftVal - rightVal; break;
                case '*': resultVal = leftVal * rightVal; break;
                case '/': resultVal = leftVal / rightVal; break;
                case '%': resultVal = leftVal - rightVal * Math.floor(leftVal/rightVal); break;
                case '^': resultVal = Math.pow(leftVal,rightVal); break;
              }
              if(!isFinite(resultVal) || isNaN(resultVal)) continue;
              if(useIntegerMode && !isIntegerResult(resultVal)) continue;
              const newExpr={type:'op',operator:op,left:left,right:right,value:resultVal};
              res.push(newExpr);
              if(operatorFlags['√'] && resultVal>=0 && getSqrtDepth(newExpr) < MAX_SQRT_DEPTH){
                let cur=newExpr; let curVal=resultVal; let depthAvail = MAX_SQRT_DEPTH - getSqrtDepth(newExpr); for(let d=1; d<=depthAvail; d++){ curVal = Math.sqrt(curVal); if(!isFinite(curVal) || isNaN(curVal)) break; if(useIntegerMode && !isIntegerResult(curVal)) break; cur={type:'op',operator:'√',left:null,right:cur,value:curVal}; res.push(cur);} }
              if(operatorFlags['!'] && resultVal>=0 && resultVal <= MAX_FACTORIAL_INPUT && Number.isInteger(resultVal) && getFactDepth(newExpr) < MAX_FACT_DEPTH){
                let cur=newExpr; let curVal=resultVal; let depthAvail = MAX_FACT_DEPTH - getFactDepth(newExpr); for(let d=1; d<=depthAvail; d++){ curVal = factorial(curVal); if(!isFinite(curVal) || isNaN(curVal)) break; cur={type:'op',operator:'!',left:null,right:cur,value:curVal}; res.push(cur);} }
            }
          }
        }
      }
    }
    memo.set(key,res); return res;
  }
  return helper(0,nums.length-1);
}

function usesAllNumbers(ast, originalNums){
  const numbers=[]; (function extract(n){ if(n.type==='num') numbers.push(n.value); if(n.left) extract(n.left); if(n.right) extract(n.right); })(ast);
  if(numbers.length !== originalNums.length) return false;
  const su=[...numbers].sort((a,b)=>a-b); const so=[...originalNums].sort((a,b)=>a-b); const EPS=1e-9; for(let i=0;i<su.length;i++){ if(Math.abs(su[i]-so[i])>EPS) return false; } return true;
}

// Adaptive fast DFS with tuning slider
function dfsFindClosest(nums,target,used,exprs,closest){
  lastTimedOut = false; // reset
  const visited=new Set();
  const Q_FACTOR=1e9;
  function quantize(v){ if(!isFinite(v)) return 'X'; return Math.round(v*Q_FACTOR)/Q_FACTOR; }
  function makeKey(arr){ return arr.map(quantize).sort((a,b)=>a-b).join(','); }
  let found=null;
  let bestDiff = closest.value ? closest.value.diff : Infinity;
  const ENABLE = { '+': !!operatorFlags['+'], '-': !!operatorFlags['-'], '*': !!operatorFlags['*'], '/': !!operatorFlags['/'], '%': !!operatorFlags['%'], '^': !!operatorFlags['^'], '√': !!operatorFlags['√'], '!': !!operatorFlags['!'] };

  const startTime = (self.performance && performance.now) ? performance.now() : Date.now();
  // Time budget grows sharply near right side: ~0.4s .. ~10s
  const timeBudgetMs = 400 + Math.pow(speedAccuracy, 2.2) * 9600; // 0 -> 400ms, 1 -> ~10s
  const deadline = startTime + timeBudgetMs;

  const absTarget = Math.abs(target) || 1;
  const baseMag = Math.max(1e4, absTarget * 16 + 500);
  // At very high accuracy we turn off magnitude pruning (speedAccuracy>=0.95)
  const magnitudeLimit = (speedAccuracy >= 0.95) ? Infinity : baseMag * (0.25 + 1.25*speedAccuracy);

  // Progressive beam: small start then widen; final max very large on right side
  const nInit = nums.length;
  const initialBeam = (function(){
    const base = 12 + 4 * nInit; // depends on number count
    const accel = (speedAccuracy < 0.15) ? 0 : Math.round(Math.pow(speedAccuracy,1.35) * 260);
    return base + accel;
  })();
  const maxBeam = Math.round( (speedAccuracy < 0.5 ? 220 : 120 + speedAccuracy * 680) ); // up to ~800
  let currentBeam = Math.min(initialBeam, maxBeam);
  const widenIntervalNodes = 2500; // widen every N node expansions
  let nodeExpandCount = 0; let widenSteps = 0;

  const toleranceBaseFactor = (speedAccuracy >= 0.95) ? 0 : (0.15 + 0.45*speedAccuracy); // disable tolerance at top
  const allowPower = (speedAccuracy > 0.35) || (speedAccuracy >= 0.95); // always allow at very high accuracy

  function maybeWiden(){
    if (speedAccuracy < 0.30) return; // skip widening in very fast region
    if (currentBeam >= maxBeam) return;
    if (nodeExpandCount % widenIntervalNodes === 0 && nodeExpandCount>0){
      // escalate multiplicatively, stronger near high accuracy
      const factor = (speedAccuracy >= 0.9) ? 1.75 : (speedAccuracy >= 0.7 ? 1.55 : 1.4);
      currentBeam = Math.min(maxBeam, Math.round(currentBeam * factor + 8));
      widenSteps++;
    }
  }

  function timeExceeded(){
    if (speedAccuracy < 0.90) return false; // only enforce long-budget side
    const now = (self.performance && performance.now) ? performance.now() : Date.now();
    return now > deadline;
  }

  function recordCandidate(val, ast, isFull){
    if(!isFull) return false;
    const diff=Math.abs(val-target);
    if(diff < bestDiff){ bestDiff = diff; closest.value={expression:serializeAST(ast), result:val, diff, isExact: diff <= EXACT_EPS}; }
    if(diff <= EXACT_EPS){ found={expression:serializeAST(ast), result:val, diff:0, isExact:true}; return true; }
    return false;
  }

  function dfs(currentNums,currentExprs){
    if(timeExceeded()){ lastTimedOut = true; return false; }
    const key=makeKey(currentNums); if(visited.has(key)) return false; visited.add(key);
    if(currentNums.length===1){
      const result=currentNums[0]; const expr=currentExprs[0];
      if(usesAllNumbers(expr, nums)){ if(recordCandidate(result, expr, true)) return true; }
      return false;
    }
    const n=currentNums.length;
    const pairMeta=[];
    for(let i=0;i<n-1;i++){
      for(let j=i+1;j<n;j++){
        const a=currentNums[i], b=currentNums[j];
        // Magnitude pruning disabled at high accuracy
        if(magnitudeLimit !== Infinity){
          if(Math.abs(a)>magnitudeLimit && Math.abs(b)>magnitudeLimit && speedAccuracy < 0.85) continue;
        }
        let bestLocal = Infinity;
        if(ENABLE['*']) bestLocal = Math.min(bestLocal, Math.abs(a*b - target));
        if(ENABLE['+']) bestLocal = Math.min(bestLocal, Math.abs(a+b - target));
        if(ENABLE['-']) { bestLocal = Math.min(bestLocal, Math.abs(a-b - target)); bestLocal = Math.min(bestLocal, Math.abs(b-a - target)); }
        if(ENABLE['/']) { if(Math.abs(b)>1e-12) bestLocal = Math.min(bestLocal, Math.abs(a/b - target)); if(Math.abs(a)>1e-12) bestLocal = Math.min(bestLocal, Math.abs(b/a - target)); }
        if(ENABLE['%']) { if(Math.abs(b)>1e-12) bestLocal = Math.min(bestLocal, Math.abs((a - b*Math.floor(a/b)) - target)); if(Math.abs(a)>1e-12) bestLocal = Math.min(bestLocal, Math.abs((b - a*Math.floor(b/a)) - target)); }
        if(allowPower && ENABLE['^']) { if(!(a===0 && b<=0)) bestLocal=Math.min(bestLocal, Math.abs(Math.pow(a,b)-target)); if(!(b===0 && a<=0)) bestLocal=Math.min(bestLocal, Math.abs(Math.pow(b,a)-target)); }
        pairMeta.push({i,j,score:bestLocal});
      }
    }
    pairMeta.sort((x,y)=>x.score-y.score);

    for(const {i,j} of pairMeta){
      if(timeExceeded()){ lastTimedOut = true; return false; }
      const a=currentNums[i], b=currentNums[j]; const exprA=currentExprs[i], exprB=currentExprs[j];
      const baseNums=[]; const baseExprs=[]; for(let k=0;k<n;k++){ if(k!==i && k!==j){ baseNums.push(currentNums[k]); baseExprs.push(currentExprs[k]); }}
      const candidates=[];
      function pushCandidate(op,la,rb,ea,eb){
        let val; const cacheKey=op+'|'+la+'|'+rb; if(opResultCache.has(cacheKey)){ val=opResultCache.get(cacheKey); } else { switch(op){ case '+': val=la+rb; break; case '-': val=la-rb; break; case '*': val=la*rb; break; case '/': val= Math.abs(rb) < 1e-12 ? NaN : la/rb; break; case '%': val= Math.abs(rb) < 1e-12 ? NaN : la - rb * Math.floor(la/rb); break; case '^': val = (la===0 && rb<=0)? NaN : Math.pow(la,rb); break; default: val=NaN; } opResultCache.set(cacheKey,val); }
        if(isNaN(val)||!isFinite(val)) return; if(useIntegerMode && !isIntegerResult(val)) return;
        if(magnitudeLimit !== Infinity && Math.abs(val)> magnitudeLimit * (2 + speedAccuracy*4)) return; // dynamic cap unless disabled
        const diff = Math.abs(val-target);
        const remaining = baseNums.length; // numbers left
        const tolerance = (remaining>=3)? toleranceBaseFactor * (remaining-2) * (1+Math.log10(absTarget+10)) : 0;
        if(toleranceBaseFactor>0 && bestDiff !== Infinity && diff > bestDiff + tolerance) return;
        candidates.push({op,val,diff,leftExpr:ea,rightExpr:eb});
      }
      if(ENABLE['+']) pushCandidate('+', a<=b?a:b, a<=b?b:a, a<=b?exprA:exprB, a<=b?exprB:exprA);
      if(ENABLE['-']){ pushCandidate('-',a,b,exprA,exprB); pushCandidate('-',b,a,exprB,exprA); }
      if(ENABLE['*']) pushCandidate('*', a<=b?a:b, a<=b?b:a, a<=b?exprA:exprB, a<=b?exprB:exprA);
      if(ENABLE['/']){ pushCandidate('/',a,b,exprA,exprB); pushCandidate('/',b,a,exprB,exprA); }
      if(ENABLE['%']){ pushCandidate('%',a,b,exprA,exprB); pushCandidate('%',b,a,exprB,exprA); }
      if(allowPower && ENABLE['^']){ pushCandidate('^',a,b,exprA,exprB); pushCandidate('^',b,a,exprB,exprA); }
      if(candidates.length===0) continue;
      candidates.sort((x,y)=>x.diff-y.diff);
      const BEAM_K = (n>=5)? Math.min(candidates.length, currentBeam) : candidates.length;
      for(let ci=0; ci<BEAM_K; ci++){
        nodeExpandCount++;
        if(timeExceeded()){ lastTimedOut = true; return false; }
        maybeWiden();
        const cand=candidates[ci];
        const ast={type:'op',operator:cand.op,left:cand.leftExpr,right:cand.rightExpr,value:cand.val};
        const variants=[{ast,val:cand.val}];
        if(operatorFlags['√'] && cand.val>=0 && MAX_SQRT_DEPTH>0 && speedAccuracy>0.3){ let sv=cand.val; let sa=ast; let d=0; const maxUnary = speedAccuracy>0.75? MAX_SQRT_DEPTH : 1; while(d<maxUnary){ sv=Math.sqrt(sv); if(isNaN(sv)||!isFinite(sv)) break; if(useIntegerMode && !isIntegerResult(sv)) break; sa={type:'op',operator:'√',left:null,right:sa,value:sv}; variants.push({ast:sa,val:sv}); d++; } }
        if(operatorFlags['!'] && cand.val>=0 && cand.val<=MAX_FACTORIAL_INPUT && Number.isInteger(cand.val) && MAX_FACT_DEPTH>0 && speedAccuracy>0.4){ let fv=cand.val; let fa=ast; let d=0; const maxFact = speedAccuracy>0.8? MAX_FACT_DEPTH : 1; while(d<maxFact){ fv=factorial(fv); if(isNaN(fv)||!isFinite(fv)) break; fa={type:'op',operator:'!',left:null,right:fa,value:fv}; variants.push({ast:fa,val:fv}); d++; } }
        for(const variant of variants){
          const valV=variant.val; if(useIntegerMode && !isIntegerResult(valV)) continue;
          const isFull = (n===2);
          if(isFull){ if(recordCandidate(valV, variant.ast, true)) return true; }
          const nextNums=baseNums.concat([valV]); const nextExprs=baseExprs.concat([variant.ast]);
          if(dfs(nextNums,nextExprs)) return true;
          if(timeExceeded()){ lastTimedOut = true; return false; }
        }
      }
      if(bestDiff <= EXACT_EPS) return true;
    }
    return false;
  }
  dfs(nums,exprs); return found;
}

// Exhaustive fallback (only used when slider near accuracy side)
function fallbackExactSearch(nums, target){
  const ENABLE = { '+': !!operatorFlags['+'], '-': !!operatorFlags['-'], '*': !!operatorFlags['*'], '/': !!operatorFlags['/'], '%': !!operatorFlags['%'], '^': !!operatorFlags['^'], '√': !!operatorFlags['√'], '!': !!operatorFlags['!'] };
  const originalNums = nums.slice();
  let best=null; let exact=null; let nodeCount=0; const NODE_LIMIT = 600000; // safety cap
  const visited = new Set();
  function key(arr){ return arr.slice().sort((a,b)=>a-b).join(','); }
  function record(ast){ const val=evaluateAST(ast); if(!isFinite(val)||isNaN(val)) return; const diff=Math.abs(val-target); if(!best || diff < best.diff) best={ expression:serializeAST(ast), result:val, diff, isExact: diff<=EXACT_EPS }; if(diff<=EXACT_EPS && usesAllNumbers(ast, originalNums)){ exact={ expression:serializeAST(ast), result:val, diff:0, isExact:true }; return true; } return false;
  }
  function dfs(arr, exprArr){ if(exact) return true; if(nodeCount++>NODE_LIMIT) return true; if(arr.length===1){ record(exprArr[0]); return false; } const k=key(arr); if(visited.has(k)) return false; visited.add(k); for(let i=0;i<arr.length-1;i++){ for(let j=i+1;j<arr.length;j++){ const a=arr[i], b=arr[j]; const ea=exprArr[i], eb=exprArr[j]; const restNums=[]; const restExpr=[]; for(let t=0;t<arr.length;t++){ if(t!==i && t!==j){ restNums.push(arr[t]); restExpr.push(exprArr[t]); }} function push(val, ast){ if(!isFinite(val)||isNaN(val)) return; if(useIntegerMode && !isIntegerResult(val)) return; const newNums=restNums.concat([val]); const newExpr=restExpr.concat([ast]); if(newNums.length===1){ if(record(ast)) return true; } if(dfs(newNums,newExpr)) return true; } if(ENABLE['+']) push(a+b,{type:'op',operator:'+',left:ea,right:eb,value:a+b}); if(ENABLE['-']){ push(a-b,{type:'op',operator:'-',left:ea,right:eb,value:a-b}); push(b-a,{type:'op',operator:'-',left:eb,right:ea,value:b-a}); } if(ENABLE['*']) push(a*b,{type:'op',operator:'*',left:ea,right:eb,value:a*b}); if(ENABLE['/']){ if(Math.abs(b)>1e-12) push(a/b,{type:'op',operator:'/',left:ea,right:eb,value:a/b}); if(Math.abs(a)>1e-12) push(b/a,{type:'op',operator:'/',left:eb,right:ea,value:b/a}); } if(ENABLE['%']){ if(Math.abs(b)>1e-12) push(a - b*Math.floor(a/b), {type:'op',operator:'%',left:ea,right:eb,value:a - b*Math.floor(a/b)}); if(Math.abs(a)>1e-12) push(b - a*Math.floor(b/a), {type:'op',operator:'%',left:eb,right:ea,value:b - a*Math.floor(b/a)}); } if(ENABLE['^']){ if(!(a===0 && b<=0)) push(Math.pow(a,b), {type:'op',operator:'^',left:ea,right:eb,value:Math.pow(a,b)}); if(!(b===0 && a<=0)) push(Math.pow(b,a), {type:'op',operator:'^',left:eb,right:ea,value:Math.pow(b,a)}); } } } return false; }
  dfs(nums.slice(), nums.map(n=>({type:'num',value:n})));
  return exact || best;
}

let lastProgressSent = 0; // throttling timestamp
const PROGRESS_INTERVAL_MS = 60; // minimum ms between progress posts

self.onmessage = function(e){
  const data=e.data; operatorFlags=data.operatorFlags; useIntegerMode=data.useIntegerMode; MAX_SQRT_DEPTH=data.MAX_SQRT_DEPTH; MAX_FACT_DEPTH=data.MAX_FACT_DEPTH; MAX_FACTORIAL_INPUT=data.MAX_FACTORIAL_INPUT; MAX_RESULTS=data.MAX_RESULTS || Infinity; if(typeof data.speedAccuracy === 'number') speedAccuracy = Math.max(0, Math.min(1, data.speedAccuracy));
  if(data.type==='findFirstFast'){
    const { nums, target } = data; calculationCache.clear(); opResultCache.clear(); let closest={ value:null }; let found=dfsFindClosest(nums,target,[], nums.map(n=>({type:'num',value:n})), closest);
    if(found){ self.postMessage({found:true, expression:found.expression, result:found.result}); return; }
    // If timed out or high accuracy side -> escalate to fallback exhaustive (even at slightly lower threshold if timedOut)
    const needFallback = (speedAccuracy >= 0.8) || lastTimedOut;
    if(!found && needFallback){ const fb = fallbackExactSearch(nums,target); if(fb && fb.isExact){ self.postMessage({found:true, expression:fb.expression, result:fb.result}); return; } if(fb && (!closest.value || fb.diff < closest.value.diff)) closest.value=fb; }
    if(closest.value){ self.postMessage({found:false, closest:closest.value, timedOut:lastTimedOut}); } else { self.postMessage({found:false, finished:true, timedOut:lastTimedOut}); } return;
  } else if (data.type==='findAll') {
    const { chunk, target, nums } = data; let results=[]; let expressionSet=new Set(); let closestResult = null; let smallestDiff = Infinity; calculationCache.clear(); expressionCache.clear(); opResultCache.clear();
    try { for(let p=0;p<chunk.length;p++){ const perm=chunk[p]; const expressions=generateAllGroupings(perm,target); if(!Array.isArray(expressions)) continue; for(let i=0;i<expressions.length;i++){ const ast=expressions[i]; const result=evaluateAST(ast); if(!isFinite(result)||isNaN(result)) continue; const diff=Math.abs(result-target); if(usesAllNumbers(ast,nums)){ if(diff < smallestDiff){ smallestDiff=diff; closestResult={ expression:serializeAST(ast), result, diff, isExact: diff <= EXACT_EPS }; const now=Date.now(); if(now-lastProgressSent>PROGRESS_INTERVAL_MS) { self.postMessage({progress:true, processed:(p+1), closest:closestResult}); lastProgressSent=now; } } if(diff <= EXACT_EPS){ const canonicalAST=canonicalizeAST(ast); const canonicalStr=serializeAST(canonicalAST); if(!expressionSet.has(canonicalStr)){ expressionSet.add(canonicalStr); results.push({ expression: canonicalStr, result }); } } } if(i % 100 === 0){ const now=Date.now(); if(now-lastProgressSent>PROGRESS_INTERVAL_MS){ self.postMessage({progress:true, processed:(p+1), closest:closestResult}); lastProgressSent=now; } } } } self.postMessage({ results, closest: closestResult || null }); }
    catch(err){ self.postMessage({ results, closest: closestResult || null, error: err.message }); return; }
    calculationCache.clear(); expressionCache.clear();
  } else if (data.type==='findAllRange') {
    const { permutations, start, end, target, nums } = data; let results=[]; let expressionSet=new Set(); let closestResult = null; let smallestDiff = Infinity; calculationCache.clear(); expressionCache.clear(); opResultCache.clear();
    try { for(let p=start; p<end; p++){ const perm=permutations[p]; const expressions=generateAllGroupings(perm,target); if(!Array.isArray(expressions)) continue; for(let i=0;i<expressions.length;i++){ const ast=expressions[i]; const result=evaluateAST(ast); if(!isFinite(result)||isNaN(result)) continue; const diff=Math.abs(result-target); if(usesAllNumbers(ast,nums)){ if(diff < smallestDiff){ smallestDiff=diff; closestResult={ expression:serializeAST(ast), result, diff, isExact: diff <= EXACT_EPS }; const now=Date.now(); if(now-lastProgressSent>PROGRESS_INTERVAL_MS){ self.postMessage({progress:true, processed:(p-start+1), closest:closestResult}); lastProgressSent=now; } } if(diff <= EXACT_EPS){ const canonicalAST=canonicalizeAST(ast); const canonicalStr=serializeAST(canonicalAST); if(!expressionSet.has(canonicalStr)){ expressionSet.add(canonicalStr); results.push({ expression: canonicalStr, result }); } } } if(i % 100 === 0){ const now=Date.now(); if(now-lastProgressSent>PROGRESS_INTERVAL_MS){ self.postMessage({progress:true, processed:(p-start+1), closest:closestResult}); lastProgressSent=now; } } } } self.postMessage({ results, closest: closestResult || null }); }
    catch(err){ self.postMessage({ results, closest: closestResult || null, error: err.message }); return; }
    calculationCache.clear(); expressionCache.clear();
  }
};