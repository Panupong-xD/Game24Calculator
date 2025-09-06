// Import WebAssembly math module
importScripts('./wasm-math.js');

// Core variables
let operatorFlags = {};
let useIntegerMode = false;
let MAX_SQRT_DEPTH = 2;
let MAX_FACT_DEPTH = 1;
let MAX_FACTORIAL_INPUT = 10;
let MAX_RESULTS = 100;
let speedAccuracy = 0.6; // 0 = fastest, 1 = most accurate (still used for heuristics)
let externalTimeBudgetMs = null; // explicit hard cap from UI (slider/5 s)
const EXACT_EPS = 1e-12;
let lastTimedOut = false; // indicates dfs fast phase stopped by time budget

const factorialCache = new Map();
const calculationCache = new Map();
const expressionCache = new Map();
const opResultCache = new Map();

// Progress throttling
let lastProgressPost = 0;
const PROGRESS_POST_INTERVAL = 180; // ms
function postProgress(closest){
  const now = (self.performance && performance.now) ? performance.now() : Date.now();
  if(now - lastProgressPost < PROGRESS_POST_INTERVAL) return;
  lastProgressPost = now;
  self.postMessage({ progress: true, closest });
}

function factorial(n){ if(n<0||n>MAX_FACTORIAL_INPUT||!Number.isInteger(n)) return NaN; if(n===0||n===1) return 1; if(factorialCache.has(n)) return factorialCache.get(n); let r; if(self.wasmMath && self.wasmMath.isReady){ r=self.wasmMath.factorial(n);} else { r=1; for(let i=2;i<=n;i++) r*=i; } factorialCache.set(n,r); return r; }

function evaluateAST(node){ if(node.type==='num') return node.value; if(node.value!==undefined) return node.value; let leftVal=node.left?evaluateAST(node.left):null; let rightVal=evaluateAST(node.right); const ck=`${node.operator}|${leftVal}|${rightVal}`; if(calculationCache.has(ck)) return calculationCache.get(ck); let result; if(self.wasmMath && self.wasmMath.isReady){ switch(node.operator){ case '+': result=operatorFlags['+']? self.wasmMath.add(leftVal,rightVal):NaN; break; case '-': result=operatorFlags['-']? self.wasmMath.sub(leftVal,rightVal):NaN; break; case '*': result=operatorFlags['*']? self.wasmMath.mul(leftVal,rightVal):NaN; break; case '/': result=operatorFlags['/'] && rightVal!==0? self.wasmMath.div(leftVal,rightVal):NaN; break; case '%': if(!operatorFlags['%']|| rightVal===0) return NaN; result= leftVal - rightVal*Math.floor(leftVal/rightVal); break; case '^': if(!operatorFlags['^']) return NaN; result = (leftVal===0 && rightVal<=0)? (rightVal===0?1:NaN) : self.wasmMath.pow(leftVal,rightVal); break; case '√': result= operatorFlags['√'] && rightVal>=0 ? self.wasmMath.sqrt(rightVal):NaN; break; case '!': result= operatorFlags['!'] && rightVal<=MAX_FACTORIAL_INPUT && rightVal>=0 && Number.isInteger(rightVal)? self.wasmMath.factorial(rightVal): NaN; break; case '||': { if(!operatorFlags['||']) return NaN; if(!Number.isInteger(leftVal)||!Number.isInteger(rightVal)|| leftVal<0 || rightVal<0) return NaN; result = parseFloat(String(Math.trunc(leftVal)) + String(Math.trunc(rightVal))); break; } case '∑': { if(!operatorFlags['∑']) return NaN; if(!Number.isInteger(leftVal)||!Number.isInteger(rightVal)|| leftVal>rightVal) return NaN; const n= rightVal-leftVal+1; result = (leftVal+rightVal)*n/2; break; }
      } } else { switch(node.operator){ case '+': result=operatorFlags['+']? leftVal+rightVal:NaN; break; case '-': result=operatorFlags['-']? leftVal-rightVal:NaN; break; case '*': result=operatorFlags['*']? leftVal*rightVal:NaN; break; case '/': result=operatorFlags['/'] && rightVal!==0? leftVal/rightVal:NaN; break; case '%': if(!operatorFlags['%']|| rightVal===0) return NaN; result= leftVal - rightVal*Math.floor(leftVal/rightVal); break; case '^': if(!operatorFlags['^']) return NaN; result = (leftVal===0 && rightVal<=0)? (rightVal===0?1:NaN) : Math.pow(leftVal,rightVal); break; case '√': result= operatorFlags['√'] && rightVal>=0 ? Math.sqrt(rightVal):NaN; break; case '!': result= operatorFlags['!'] && rightVal<=MAX_FACTORIAL_INPUT && rightVal>=0 && Number.isInteger(rightVal)? factorial(rightVal): NaN; break; case '||': { if(!operatorFlags['||']) return NaN; if(!Number.isInteger(leftVal)||!Number.isInteger(rightVal)|| leftVal<0 || rightVal<0) return NaN; result = parseFloat(String(Math.trunc(leftVal)) + String(Math.trunc(rightVal))); break; } case '∑': { if(!operatorFlags['∑']) return NaN; if(!Number.isInteger(leftVal)||!Number.isInteger(rightVal)|| leftVal>rightVal) return NaN; const n= rightVal-leftVal+1; result = (leftVal+rightVal)*n/2; break; }
      } }
  if(!isNaN(result)){ if(calculationCache.size>1000000) calculationCache.clear(); calculationCache.set(ck,result); node.value=result; }
  return result; }

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
            const ops=[]; if(operatorFlags['+']) ops.push('+'); if(operatorFlags['-']) ops.push('-'); if(operatorFlags['*']) ops.push('*'); if(operatorFlags['/']) ops.push('/'); if(operatorFlags['%']) ops.push('%'); if(operatorFlags['^']) ops.push('^'); if(operatorFlags['||']) ops.push('||'); if(operatorFlags['∑']) ops.push('∑');
            for(const op of ops){
              if(op==='/' && rightVal===0) continue;
              if(op==='%' && rightVal===0) continue;
              if(op==='^' && leftVal===0 && rightVal<=0) continue;
              let resultVal;
              switch(op){
                case '+': resultVal = leftVal + rightVal; break;
                case '-': resultVal = leftVal - rightVal; break;
                case '*': resultVal = leftVal * rightVal; break;
                case '/': resultVal = rightVal===0? NaN : leftVal / rightVal; break;
                case '%': resultVal = rightVal===0? NaN : leftVal - rightVal * Math.floor(leftVal/rightVal); break;
                case '^': resultVal = (leftVal===0 && rightVal<=0)? NaN : Math.pow(leftVal,rightVal); break;
                case '||': resultVal = (Number.isInteger(leftVal)&&Number.isInteger(rightVal)&& leftVal>=0 && rightVal>=0)? parseFloat(String(Math.trunc(leftVal))+String(Math.trunc(rightVal))) : NaN; break;
                case '∑': resultVal = (Number.isInteger(leftVal)&&Number.isInteger(rightVal)&& leftVal<=rightVal)? ((leftVal+rightVal)*(rightVal-leftVal+1)/2) : NaN; break;
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

// Adaptive time-aware DFS search. externalTimeBudgetMs is a strict hard cap.
function dfsFindClosest(nums,target,closest){
  lastTimedOut=false;
  const visited=new Set();
  const QF=1e9; function q(v){ if(!isFinite(v)) return 'X'; return Math.round(v*QF)/QF; }
  function key(arr){ return arr.map(q).sort((a,b)=>a-b).join(','); }
  let found=null; let bestDiff = closest.value? closest.value.diff : Infinity;
  const ENABLE = { '+': !!operatorFlags['+'], '-': !!operatorFlags['-'], '*': !!operatorFlags['*'], '/': !!operatorFlags['/'], '%': !!operatorFlags['%'], '^': !!operatorFlags['^'], '√': !!operatorFlags['√'], '!': !!operatorFlags['!'], '||': !!operatorFlags['||'], '∑': !!operatorFlags['∑'] };

  const start = (self.performance && performance.now)? performance.now(): Date.now();
  const hardDeadline = start + (externalTimeBudgetMs != null ? externalTimeBudgetMs : (400 + Math.pow(speedAccuracy,2.2)*9600)); // fallback if not provided
  // Ensure higher slider values guarantee at least proportional time usage.

  // scale breadth with available time: more time -> wider beam, deeper unaries
  const timeSec = (externalTimeBudgetMs||0)/1000;
  const breadthBoost = 1 + Math.min(2.5, timeSec/6); // up to 1+ ~2.5
  const magnitudeRelax = Math.min(3.5, 0.8 + timeSec/6); // increases allowed magnitude
  const enableFallbackThresholdSec = 6; // if time >= this we'll plan fallback automatically later if not exact

  const targetMag = Math.abs(target)||1;
  const baseMagLimit = targetMag*16 + 500;
  const magnitudeLimit = (speedAccuracy > 0.95 || timeSec > 14) ? Infinity : baseMagLimit * magnitudeRelax;

  const initialBeam = Math.round( (12 + 4*nums.length) * breadthBoost );
  const maxBeam = Math.round( (speedAccuracy < 0.5 ? 220 : 120 + speedAccuracy*680) * breadthBoost );
  let currentBeam = Math.min(initialBeam, maxBeam);
  const widenIntervalNodes = 2200; // more frequent with more time
  let nodeExpandCount=0;

  const allowPower = ENABLE['^'] && (speedAccuracy > 0.25 || timeSec > 3);
  const maxSqrtUnary = (speedAccuracy > 0.7 || timeSec > 4) ? MAX_SQRT_DEPTH : 1;
  const maxFactUnary = (speedAccuracy > 0.8 || timeSec > 5) ? MAX_FACT_DEPTH : 1;

  function widen(){ if(currentBeam < maxBeam){ currentBeam = Math.min(maxBeam, Math.round(currentBeam * (1.45 + 0.25*speedAccuracy))); } }
  function timeExceeded(){ const now=(self.performance && performance.now)? performance.now(): Date.now(); return now > hardDeadline; }

  function recordCandidate(val, ast, isFull){ if(!isFull) return false; const diff=Math.abs(val-target); if(diff < bestDiff){ bestDiff=diff; closest.value={ expression: serializeAST(ast), result: val, diff, isExact: diff<=EXACT_EPS }; postProgress(closest.value); } if(diff<=EXACT_EPS){ found={ expression: serializeAST(ast), result: val, diff:0, isExact:true }; return true; } return false; }

  function dfs(curNums, curExpr){ if(timeExceeded()){ lastTimedOut=true; return true; } const k=key(curNums); if(visited.has(k)) return false; visited.add(k);
    if(curNums.length===1){ const r=curNums[0]; const e=curExpr[0]; if(usesAllNumbers(e, nums)){ if(recordCandidate(r,e,true)) return true; } return false; }
    const n=curNums.length; const pairMeta=[]; for(let i=0;i<n-1;i++){ for(let j=i+1;j<n;j++){ const a=curNums[i], b=curNums[j]; if(magnitudeLimit!==Infinity && Math.abs(a)>magnitudeLimit && Math.abs(b)>magnitudeLimit) continue; let bestLocal=Infinity; if(ENABLE['*']) bestLocal=Math.min(bestLocal, Math.abs(a*b-target)); if(ENABLE['+']) bestLocal=Math.min(bestLocal, Math.abs(a+b-target)); if(ENABLE['-']){ bestLocal=Math.min(bestLocal, Math.abs(a-b-target)); bestLocal=Math.min(bestLocal, Math.abs(b-a-target)); } if(ENABLE['/']){ if(Math.abs(b)>1e-12) bestLocal=Math.min(bestLocal, Math.abs(a/b-target)); if(Math.abs(a)>1e-12) bestLocal=Math.min(bestLocal, Math.abs(b/a-target)); } if(ENABLE['%']){ if(Math.abs(b)>1e-12) bestLocal=Math.min(bestLocal, Math.abs((a - b*Math.floor(a/b))-target)); if(Math.abs(a)>1e-12) bestLocal=Math.min(bestLocal, Math.abs((b - a*Math.floor(b/a))-target)); } if(allowPower){ if(!(a===0 && b<=0)) bestLocal=Math.min(bestLocal, Math.abs(Math.pow(a,b)-target)); if(!(b===0 && a<=0)) bestLocal=Math.min(bestLocal, Math.abs(Math.pow(b,a)-target)); } pairMeta.push({i,j,score:bestLocal}); } }
    pairMeta.sort((x,y)=>x.score-y.score);

    for(const {i,j} of pairMeta){ if(timeExceeded()){ lastTimedOut=true; return true; } const a=curNums[i], b=curNums[j]; const ea=curExpr[i], eb=curExpr[j]; const restNums=[]; const restExpr=[]; for(let t=0;t<n;t++){ if(t!==i && t!==j){ restNums.push(curNums[t]); restExpr.push(curExpr[t]); }} const candidates=[]; function pushCandidate(op,la,rb,EA,EB){ let val; const ck=op+'|'+la+'|'+rb; if(opResultCache.has(ck)){ val=opResultCache.get(ck);} else { switch(op){ case '+': val=la+rb; break; case '-': val=la-rb; break; case '*': val=la*rb; break; case '/': val= Math.abs(rb)<1e-12? NaN: la/rb; break; case '%': val= Math.abs(rb)<1e-12? NaN: la - rb*Math.floor(la/rb); break; case '^': val = (la===0 && rb<=0)? NaN: Math.pow(la,rb); break; case '||': val = (Number.isInteger(la)&&Number.isInteger(rb)&& la>=0 && rb>=0)? parseFloat(String(Math.trunc(la))+String(Math.trunc(rb))) : NaN; break; case '∑': val = (Number.isInteger(la)&&Number.isInteger(rb)&& la<=rb)? ((la+rb)*(rb-la+1)/2) : NaN; break; default: val=NaN; } opResultCache.set(ck,val);} if(isNaN(val)||!isFinite(val)) return; if(useIntegerMode && !isIntegerResult(val)) return; if(magnitudeLimit!==Infinity && Math.abs(val) > magnitudeLimit * (2 + speedAccuracy*4)) return; const diff=Math.abs(val-target); candidates.push({op,val,diff,left:EA,right:EB}); }
      if(ENABLE['+']) pushCandidate('+', a<=b?a:b, a<=b?b:a, a<=b?ea:eb, a<=b?eb:ea);
      if(ENABLE['-']){ pushCandidate('-',a,b,ea,eb); pushCandidate('-',b,a,eb,ea); }
      if(ENABLE['*']) pushCandidate('*', a<=b?a:b, a<=b?b:a, a<=b?ea:eb, a<=b?eb:ea);
      if(ENABLE['/']){ pushCandidate('/',a,b,ea,eb); pushCandidate('/',b,a,eb,ea); }
      if(ENABLE['%']){ pushCandidate('%',a,b,ea,eb); pushCandidate('%',b,a,eb,ea); }
      if(allowPower && ENABLE['^']){ pushCandidate('^',a,b,ea,eb); pushCandidate('^',b,a,eb,ea); }
      if(ENABLE['||']){ pushCandidate('||',a,b,ea,eb); pushCandidate('||',b,a,eb,ea); }
      if(ENABLE['∑']){ pushCandidate('∑',a,b,ea,eb); /* order matters: a must <= b, pushCandidate will filter */ pushCandidate('∑',b,a,eb,ea); }
      if(candidates.length===0) continue;
      candidates.sort((x,y)=>x.diff-y.diff);
      const BEAM = (n>=5)? Math.min(candidates.length, currentBeam) : candidates.length;
      for(let ci=0; ci<BEAM; ci++){
        nodeExpandCount++; if(nodeExpandCount % widenIntervalNodes ===0) widen(); if(timeExceeded()){ lastTimedOut=true; return true; }
        const cand=candidates[ci]; const ast={type:'op',operator:cand.op,left:cand.left,right:cand.right,value:cand.val}; const variants=[{ast,val:cand.val}];
        if(ENABLE['√'] && cand.val>=0 && MAX_SQRT_DEPTH>0){ let sv=cand.val, sa=ast; let depth=0; const limit = maxSqrtUnary; while(depth<limit){ sv=Math.sqrt(sv); if(!isFinite(sv)||isNaN(sv)) break; if(useIntegerMode && !isIntegerResult(sv)) break; sa={type:'op',operator:'√',left:null,right:sa,value:sv}; variants.push({ast:sa,val:sv}); depth++; if(timeExceeded()){ lastTimedOut=true; break; } }
        }
        if(ENABLE['!'] && cand.val>=0 && cand.val<=MAX_FACTORIAL_INPUT && Number.isInteger(cand.val) && MAX_FACT_DEPTH>0){ let fv=cand.val, fa=ast; let depth=0; const limit = maxFactUnary; while(depth<limit){ fv=factorial(fv); if(!isFinite(fv)||isNaN(fv)) break; fa={type:'op',operator:'!',left:null,right:fa,value:fv}; variants.push({ast:fa,val:fv}); depth++; if(timeExceeded()){ lastTimedOut=true; break; } }
        }
        for(const v of variants){ const valV=v.val; if(useIntegerMode && !isIntegerResult(valV)) continue; const isFull = (n===2); if(isFull){ if(recordCandidate(valV, v.ast, true)) return true; }
          const nextNums=restNums.concat([valV]); const nextExpr=restExpr.concat([v.ast]); if(dfs(nextNums,nextExpr)) return true; if(timeExceeded()){ lastTimedOut=true; return true; }
        }
        if(bestDiff<=EXACT_EPS) return true;
      }
    }
    return false;
  }
  dfs(nums, nums.map(n=>({type:'num',value:n})));
  return found;
}

// Exhaustive fallback (only if time remains) searches systematically using full operators.
function fallbackExactSearch(nums,target){ const ENABLE={ '+':!!operatorFlags['+'], '-':!!operatorFlags['-'], '*':!!operatorFlags['*'], '/':!!operatorFlags['/'], '%':!!operatorFlags['%'], '^':!!operatorFlags['^'], '√':!!operatorFlags['√'], '!':!!operatorFlags['!'], '||': !!operatorFlags['||'], '∑': !!operatorFlags['∑'] }; const original=nums.slice(); let best=null; let exact=null; let nodeCount=0; const NODE_LIMIT=900000; const visited=new Set(); function k(a){ return a.slice().sort((x,y)=>x-y).join(','); } function record(ast){ const val=evaluateAST(ast); if(!isFinite(val)||isNaN(val)) return; const diff=Math.abs(val-target); if(!best || diff<best.diff){ best={expression:serializeAST(ast), result:val, diff, isExact: diff<=EXACT_EPS}; postProgress(best); } if(diff<=EXACT_EPS && usesAllNumbers(ast,original)){ exact={expression:serializeAST(ast), result:val, diff:0, isExact:true}; return true;} return false; }
  const start=(self.performance && performance.now)? performance.now(): Date.now();
  function timeExceeded(){ const now=(self.performance && performance.now)? performance.now(): Date.now(); return externalTimeBudgetMs!=null && now > start + externalTimeBudgetMs; }
  function dfs(arr, exprArr){ if(exact) return true; if(nodeCount++ > NODE_LIMIT) return true; if(timeExceeded()) return true; if(arr.length===1){ record(exprArr[0]); return false; } const kk=k(arr); if(visited.has(kk)) return false; visited.add(kk); for(let i=0;i<arr.length-1;i++){ for(let j=i+1;j<arr.length;j++){ if(timeExceeded()) return true; const a=arr[i], b=arr[j]; const ea=exprArr[i], eb=exprArr[j]; const restN=[]; const restE=[]; for(let t=0;t<arr.length;t++){ if(t!==i && t!==j){ restN.push(arr[t]); restE.push(exprArr[t]); }} function push(val, ast){ if(!isFinite(val)||isNaN(val)) return; if(useIntegerMode && !isIntegerResult(val)) return; const newNums=restN.concat([val]); const newExpr=restE.concat([ast]); if(newNums.length===1){ if(record(ast)) return true; } if(dfs(newNums,newExpr)) return true; return false; }
      if(ENABLE['+']) if(push(a+b,{type:'op',operator:'+',left:ea,right:eb,value:a+b})) return true;
      if(ENABLE['-']){ if(push(a-b,{type:'op',operator:'-',left:ea,right:eb,value:a-b})) return true; if(push(b-a,{type:'op',operator:'-',left:eb,right:ea,value:b-a})) return true; }
      if(ENABLE['*']) if(push(a*b,{type:'op',operator:'*',left:ea,right:eb,value:a*b})) return true;
      if(ENABLE['/']){ if(Math.abs(b)>1e-12 && push(a/b,{type:'op',operator:'/',left:ea,right:eb,value:a/b})) return true; if(Math.abs(a)>1e-12 && push(b/a,{type:'op',operator:'/',left:eb,right:ea,value:b/a})) return true; }
      if(ENABLE['%']){ if(Math.abs(b)>1e-12 && push(a - b*Math.floor(a/b), {type:'op',operator:'%',left:ea,right:eb,value:a - b*Math.floor(a/b)})) return true; if(Math.abs(a)>1e-12 && push(b - a*Math.floor(b/a), {type:'op',operator:'%',left:eb,right:ea,value:b - a*Math.floor(b/a)})) return true; }
      if(ENABLE['^']){ if(!(a===0 && b<=0) && push(Math.pow(a,b), {type:'op',operator:'^',left:ea,right:eb,value:Math.pow(a,b)})) return true; if(!(b===0 && a<=0) && push(Math.pow(b,a), {type:'op',operator:'^',left:eb,right:ea,value:Math.pow(b,a)})) return true; }
      if(ENABLE['||']){ if(Number.isInteger(a) && Number.isInteger(b) && a>=0 && b>=0) push(parseFloat(String(Math.trunc(a))+String(Math.trunc(b))), {type:'op',operator:'||',left:ea,right:eb,value:parseFloat(String(Math.trunc(a))+String(Math.trunc(b)))}); if(Number.isInteger(b) && Number.isInteger(a) && b>=0 && a>=0) push(parseFloat(String(Math.trunc(b))+String(Math.trunc(a))), {type:'op',operator:'||',left:eb,right:ea,value:parseFloat(String(Math.trunc(b))+String(Math.trunc(a)))}); }
      if(ENABLE['∑']){ if(Number.isInteger(a) && Number.isInteger(b) && a<=b) push(((a+b)*(b-a+1)/2), {type:'op',operator:'∑',left:ea,right:eb,value:((a+b)*(b-a+1)/2)}); if(Number.isInteger(b) && Number.isInteger(a) && b<=a) push(((b+a)*(a-b+1)/2), {type:'op',operator:'∑',left:eb,right:ea,value:((b+a)*(a-b+1)/2)}); }
    } }
    return false; }
  dfs(nums.slice(), nums.map(n=>({type:'num',value:n})));
  return exact || best; }

self.onmessage = function(e){ const data=e.data; operatorFlags=data.operatorFlags; useIntegerMode=data.useIntegerMode; MAX_SQRT_DEPTH=data.MAX_SQRT_DEPTH; MAX_FACT_DEPTH=data.MAX_FACT_DEPTH; MAX_FACTORIAL_INPUT=data.MAX_FACTORIAL_INPUT; MAX_RESULTS=data.MAX_RESULTS||Infinity; if(typeof data.speedAccuracy==='number') speedAccuracy=Math.max(0,Math.min(1,data.speedAccuracy)); if(typeof data.timeBudgetMs==='number') externalTimeBudgetMs = Math.max(50, Math.min(20000, data.timeBudgetMs)); else externalTimeBudgetMs=null;
  if(data.type==='findFirstFast'){
    calculationCache.clear(); opResultCache.clear(); factorialCache.clear(); lastProgressPost=0; const { nums, target } = data; let closest={ value:null };
    const found = dfsFindClosest(nums,target,closest);
    if(found){ self.postMessage({found:true, expression:found.expression, result:found.result}); return; }
    // Determine if fallback should run (only if time budget not exhausted earlier)
    const remainingTime = (function(){ if(externalTimeBudgetMs==null) return 0; const now=(self.performance && performance.now)? performance.now(): Date.now(); // derive start from deadline - budget approximation
      // Not tracking start separately for fallback: if DFS timed out quickly remainingTime ~0
      return 0; })(); // simplified: fallback still allowed if high speedAccuracy or large budget signaled by slider
    const needFallback = (speedAccuracy >= 0.82) || (externalTimeBudgetMs!=null && externalTimeBudgetMs > 5000 && lastTimedOut);
    if(!found && needFallback){ const fb = fallbackExactSearch(nums,target); if(fb && fb.isExact){ self.postMessage({found:true, expression:fb.expression, result:fb.result}); return; } if(fb && (!closest.value || fb.diff < closest.value.diff)) closest.value=fb; }
    if(closest.value){ self.postMessage({ found:false, closest: closest.value, timedOut:lastTimedOut }); } else { self.postMessage({ found:false, finished:true, timedOut:lastTimedOut }); }
  } else if(data.type==='findAll' || data.type==='findAllRange') {
    // retain existing exhaustive modes (unchanged structural logic) -- can reuse from previous version
    const { permutations, start, end, target, nums, chunk } = data; const EXACT = EXACT_EPS; let results=[]; let expressionSet=new Set(); let closestResult=null; let smallestDiff=Infinity; calculationCache.clear(); expressionCache.clear(); opResultCache.clear();
    function processExpression(ast){ const result=evaluateAST(ast); if(!isFinite(result)||isNaN(result)) return; const diff=Math.abs(result-target); if(usesAllNumbers(ast,nums)){ if(diff<smallestDiff){ smallestDiff=diff; closestResult={ expression:serializeAST(ast), result, diff, isExact: diff<=EXACT }; postProgress(closestResult); } if(diff<=EXACT){ const canonicalAST=canonicalizeAST(ast); const canonicalStr=serializeAST(canonicalAST); if(!expressionSet.has(canonicalStr)){ expressionSet.add(canonicalStr); results.push({ expression: canonicalStr, result }); } } } }
    try { if(data.type==='findAllRange'){ for(let p=start; p<end; p++){ const perm=permutations[p]; const expressions=generateAllGroupings(perm,target); if(!Array.isArray(expressions)) continue; for(let i=0;i<expressions.length;i++){ processExpression(expressions[i]); } } } else { for(let p=0;p<chunk.length;p++){ const perm=chunk[p]; const expressions=generateAllGroupings(perm,target); if(!Array.isArray(expressions)) continue; for(let i=0;i<expressions.length;i++){ processExpression(expressions[i]); } } } self.postMessage({ results, closest: closestResult || null }); } catch(err){ self.postMessage({ results, closest: closestResult || null, error: err.message }); }
  }
};