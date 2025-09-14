// Import WebAssembly math module
importScripts('./wasm-math.js');

// Core variables
let operatorFlags = {};
let useIntegerMode = false;
let MAX_SQRT_DEPTH = 1;
let MAX_FACT_DEPTH = 1;
let MAX_LOG_DEPTH = 1;
let MAX_LN_DEPTH = 1;
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

function evaluateAST(node){ if(node.type==='num') return node.value; if(node.value!==undefined) return node.value; let leftVal=node.left?evaluateAST(node.left):null; let rightVal=evaluateAST(node.right); const ck=`${node.operator}|${leftVal}|${rightVal}`; if(calculationCache.has(ck)) return calculationCache.get(ck); let result; if(self.wasmMath && self.wasmMath.isReady){ switch(node.operator){ case '+': result=operatorFlags['+']? self.wasmMath.add(leftVal,rightVal):NaN; break; case '-': result=operatorFlags['-']? self.wasmMath.sub(leftVal,rightVal):NaN; break; case '*': result=operatorFlags['*']? self.wasmMath.mul(leftVal,rightVal):NaN; break; case '/': result=operatorFlags['/'] && rightVal!==0? self.wasmMath.div(leftVal,rightVal):NaN; break; case '%': if(!operatorFlags['%']|| rightVal===0) return NaN; result= leftVal - rightVal*Math.floor(leftVal/rightVal); break; case '^': if(!operatorFlags['^']) return NaN; result = (leftVal===0 && rightVal<=0)? (rightVal===0?1:NaN) : self.wasmMath.pow(leftVal,rightVal); break; case '√': result= operatorFlags['√'] && rightVal>=0 ? self.wasmMath.sqrt(rightVal):NaN; break; case '!': result= operatorFlags['!'] && rightVal<=MAX_FACTORIAL_INPUT && rightVal>=0 && Number.isInteger(rightVal)? self.wasmMath.factorial(rightVal): NaN; break; case 'log': result = operatorFlags['log'] && rightVal>0 ? Math.log10(rightVal) : NaN; break; case 'ln': result = operatorFlags['ln'] && rightVal>0 ? Math.log(rightVal) : NaN; break; case '||': { if(!operatorFlags['||']) return NaN; if(!Number.isInteger(leftVal)||!Number.isInteger(rightVal)|| leftVal<0 || rightVal<0) return NaN; result = parseFloat(String(Math.trunc(leftVal)) + String(Math.trunc(rightVal))); break; } case '∑': { if(!operatorFlags['∑']) return NaN; if(!Number.isInteger(leftVal)||!Number.isInteger(rightVal)|| leftVal>rightVal) return NaN; const n= rightVal-leftVal+1; result = (leftVal+rightVal)*n/2; break; } } } else { switch(node.operator){ case '+': result=operatorFlags['+']? leftVal+rightVal:NaN; break; case '-': result=operatorFlags['-']? leftVal-rightVal:NaN; break; case '*': result=operatorFlags['*']? leftVal*rightVal:NaN; break; case '/': result=operatorFlags['/'] && rightVal!==0? leftVal/rightVal:NaN; break; case '%': if(!operatorFlags['%']|| rightVal===0) return NaN; result= leftVal - rightVal*Math.floor(leftVal/rightVal); break; case '^': if(!operatorFlags['^']) return NaN; result = (leftVal===0 && rightVal<=0)? (rightVal===0?1:NaN) : Math.pow(leftVal,rightVal); break; case '√': result= operatorFlags['√'] && rightVal>=0 ? Math.sqrt(rightVal):NaN; break; case '!': result= operatorFlags['!'] && rightVal<=MAX_FACTORIAL_INPUT && rightVal>=0 && Number.isInteger(rightVal)? factorial(rightVal): NaN; break; case 'log': result = operatorFlags['log'] && rightVal>0 ? Math.log10(rightVal) : NaN; break; case 'ln': result = operatorFlags['ln'] && rightVal>0 ? Math.log(rightVal) : NaN; break; case '||': { if(!operatorFlags['||']) return NaN; if(!Number.isInteger(leftVal)||!Number.isInteger(rightVal)|| leftVal<0 || rightVal<0) return NaN; result = parseFloat(String(Math.trunc(leftVal)) + String(Math.trunc(rightVal))); break; } case '∑': { if(!operatorFlags['∑']) return NaN; if(!Number.isInteger(leftVal)||!Number.isInteger(rightVal)|| leftVal>rightVal) return NaN; const n= rightVal-leftVal+1; result = (leftVal+rightVal)*n/2; break; } } } if(!isNaN(result)){ if(calculationCache.size>1000000) calculationCache.clear(); calculationCache.set(ck,result); node.value=result; } return result; }

function isIntegerResult(r){ return Number.isInteger(r) || Math.abs(r - Math.round(r)) < 0.0001; }
function serializeAST(node){ if(node.type==='num') return node.value.toString(); if(node.operator==='√') return `√(${serializeAST(node.right)})`; if(node.operator==='!') return `(${serializeAST(node.right)})!`; if(node.operator==='log') return `log(${serializeAST(node.right)})`; if(node.operator==='ln') return `ln(${serializeAST(node.right)})`; return `(${node.left?serializeAST(node.left):''} ${node.operator} ${serializeAST(node.right)})`; }
function canonicalizeAST(node){ if(node.type==='num') return node; let left=node.left?canonicalizeAST(node.left):null; let right=canonicalizeAST(node.right); if(node.operator==='+'||node.operator==='*'||node.operator==='%'){ let ls=serializeAST(left), rs=serializeAST(right); if(ls>rs) return {type:'op',operator:node.operator,left:right,right:left,value:node.value}; } return {type:'op',operator:node.operator,left,right,value:node.value}; }
function getSqrtDepth(n){ if(n.type==='num') return 0; if(n.operator==='√') return 1+getSqrtDepth(n.right); let ld=n.left?getSqrtDepth(n.left):0; let rd=n.right?getSqrtDepth(n.right):0; return Math.max(ld,rd);} 
function getFactDepth(n){ if(n.type==='num') return 0; if(n.operator==='!') return 1+getFactDepth(n.right); let ld=n.left?getFactDepth(n.left):0; let rd=n.right?getFactDepth(n.right):0; return Math.max(ld,rd);} 
function getLogDepth(n){ if(n.type==='num') return 0; if(n.operator==='log') return 1+getLogDepth(n.right); let ld=n.left?getLogDepth(n.left):0; let rd=n.right?getLogDepth(n.right):0; return Math.max(ld,rd);} 
function getLnDepth(n){ if(n.type==='num') return 0; if(n.operator==='ln') return 1+getLnDepth(n.right); let ld=n.left?getLnDepth(n.left):0; let rd=n.right?getLnDepth(n.right):0; return Math.max(ld,rd);} 

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
  if(operatorFlags['log'] && nums[start]>0){ let cur=numNode; for(let i=1;i<=MAX_LOG_DEPTH && operatorFlags['log'];i++){ cur={type:'op',operator:'log',left:null,right:cur}; const v=evaluateAST(cur); if(!isNaN(v) && (!useIntegerMode||isIntegerResult(v))) res.push(cur); else break;} }
  if(operatorFlags['ln'] && nums[start]>0){ let cur=numNode; for(let i=1;i<=MAX_LN_DEPTH && operatorFlags['ln'];i++){ cur={type:'op',operator:'ln',left:null,right:cur}; const v=evaluateAST(cur); if(!isNaN(v) && (!useIntegerMode||isIntegerResult(v))) res.push(cur); else break;} }
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
              if(operatorFlags['log'] && resultVal>0 && getLogDepth(newExpr) < MAX_LOG_DEPTH){
                let cur=newExpr; let curVal=resultVal; let depthAvail = MAX_LOG_DEPTH - getLogDepth(newExpr); for(let d=1; d<=depthAvail; d++){ curVal = Math.log10(curVal); if(!isFinite(curVal) || isNaN(curVal)) break; if(useIntegerMode && !isIntegerResult(curVal)) break; cur={type:'op',operator:'log',left:null,right:cur,value:curVal}; res.push(cur);} }
              if(operatorFlags['ln'] && resultVal>0 && getLnDepth(newExpr) < MAX_LN_DEPTH){
                let cur=newExpr; let curVal=resultVal; let depthAvail = MAX_LN_DEPTH - getLnDepth(newExpr); for(let d=1; d<=depthAvail; d++){ curVal = Math.log(curVal); if(!isFinite(curVal) || isNaN(curVal)) break; if(useIntegerMode && !isIntegerResult(curVal)) break; cur={type:'op',operator:'ln',left:null,right:cur,value:curVal}; res.push(cur);} }
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
  const ENABLE = { '+': !!operatorFlags['+'], '-': !!operatorFlags['-'], '*': !!operatorFlags['*'], '/': !!operatorFlags['/'], '%': !!operatorFlags['%'], '^': !!operatorFlags['^'], '√': !!operatorFlags['√'], '!': !!operatorFlags['!'], '||': !!operatorFlags['||'], '∑': !!operatorFlags['∑'], 'log': !!operatorFlags['log'], 'ln': !!operatorFlags['ln'] };

    const start = (self.performance && performance.now) ? performance.now() : Date.now();
  const hardDeadline = start + (externalTimeBudgetMs != null ? externalTimeBudgetMs : (400 + Math.pow(speedAccuracy,2.2)*9600));
  const timeSec = (externalTimeBudgetMs||0)/1000;
  const breadthBoost = 1 + Math.min(2.5, timeSec/6);
  const magnitudeRelax = Math.min(3.5, 0.8 + timeSec/6);

  const targetMag = Math.abs(target)||1;
  const baseMagLimit = targetMag*16 + 500;
  const magnitudeLimit = (speedAccuracy > 0.95 || timeSec > 14) ? Infinity : baseMagLimit * magnitudeRelax;

  const initialBeam = Math.round( (12 + 4*nums.length) * breadthBoost );
  const maxBeam = Math.round( (speedAccuracy < 0.5 ? 220 : 120 + speedAccuracy*680) * breadthBoost );
  let currentBeam = Math.min(initialBeam, maxBeam);
  const widenIntervalNodes = 2200;
  let nodeExpandCount=0;

  const allowPower = ENABLE['^'] && (speedAccuracy > 0.25 || timeSec > 3);
  const maxSqrtUnary = (speedAccuracy > 0.7 || timeSec > 4) ? MAX_SQRT_DEPTH : 1;
  const maxFactUnary = (speedAccuracy > 0.8 || timeSec > 5) ? MAX_FACT_DEPTH : 1;
  const maxLogUnary  = (speedAccuracy > 0.7 || timeSec > 4) ? MAX_LOG_DEPTH : 1;
  const maxLnUnary   = (speedAccuracy > 0.7 || timeSec > 4) ? MAX_LN_DEPTH  : 1;

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
      if(ENABLE['∑']){ pushCandidate('∑',a,b,ea,eb); pushCandidate('∑',b,a,eb,ea); }
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
  if(ENABLE['log'] && cand.val>0 && MAX_LOG_DEPTH>0){ let lv=cand.val, la=ast; let depth=0; const limit = maxLogUnary; while(depth<limit){ lv=Math.log10(lv); if(!isFinite(lv)||isNaN(lv)) break; if(useIntegerMode && !isIntegerResult(lv)) break; la={type:'op',operator:'log',left:null,right:la,value:lv}; variants.push({ast:la,val:lv}); depth++; if(timeExceeded()){ lastTimedOut=true; break; } }
        }
  if(ENABLE['ln'] && cand.val>0 && MAX_LN_DEPTH>0){ let lv=cand.val, la=ast; let depth=0; const limit = maxLnUnary; while(depth<limit){ lv=Math.log(lv); if(!isFinite(lv)||isNaN(lv)) break; if(useIntegerMode && !isIntegerResult(lv)) break; la={type:'op',operator:'ln',left:null,right:la,value:lv}; variants.push({ast:la,val:lv}); depth++; if(timeExceeded()){ lastTimedOut=true; break; } }
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

// Exhaustive fallback (only if time remains)
function fallbackExactSearch(nums,target){ const ENABLE={ '+':!!operatorFlags['+'], '-':!!operatorFlags['-'], '*':!!operatorFlags['*'], '/':!!operatorFlags['/'], '%':!!operatorFlags['%'], '^':!!operatorFlags['^'], '√':!!operatorFlags['√'], '!':!!operatorFlags['!'], '||': !!operatorFlags['||'], '∑': !!operatorFlags['∑'], 'log': !!operatorFlags['log'], 'ln': !!operatorFlags['ln'] }; const original=nums.slice(); let best=null; let exact=null; let nodeCount=0; const NODE_LIMIT=900000; const visited=new Set(); function k(a){ return a.slice().sort((x,y)=>x-y).join(','); } function record(ast){ const val=evaluateAST(ast); if(!isFinite(val)||isNaN(val)) return; const diff=Math.abs(val-target); if(!best || diff<best.diff){ best={expression:serializeAST(ast), result:val, diff, isExact: diff<=EXACT_EPS}; postProgress(best); } if(diff<=EXACT_EPS && usesAllNumbers(ast,original)){ exact={expression:serializeAST(ast), result:val, diff:0, isExact:true}; return true;} return false; }
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

// ---------------- FAST MODE ANYTIME MULTI-PHASE IMPLEMENTATION -----------------
function fast_runAnytime(numsInput, target, allowPartial=false){
  const nowFn = (self.performance && performance.now) ? ()=>performance.now() : ()=>Date.now();
  const start = nowFn();
  const budget = externalTimeBudgetMs != null ? externalTimeBudgetMs : (400 + Math.pow(speedAccuracy,2.2)*9600);
  const deadline = start + budget;
  const n = numsInput.length;
  let nums = numsInput.slice();
  const LARGE_N_THRESHOLD = 7; // configurable pivot
  const largeN = n >= LARGE_N_THRESHOLD;
  let best = null; // {expression,result,diff,isExact, source}
  let bestHistory = [];
  let lastImprovementTime = start;
  // Update best ONLY if expression uses all numbers (full=true). Partial expressions are ignored entirely per requirement.
  function updateBest(expr,result, full=true){
    if(!full && !allowPartial) return false; // enforce full unless partial allowed
    const diff=Math.abs(result-target);
    // isExact only meaningful for full expressions
    if(!best || diff < best.diff){
      best={expression:expr,result,diff,isExact:diff<=EXACT_EPS, source:currentPhase};
      postProgress(best);
      bestHistory.push({t:nowFn(), diff});
      lastImprovementTime = nowFn();
      if(best.isExact){ return true; }
    }
    return false;
  }
  function timeLeft(){ return deadline - nowFn(); }
  function timeExceeded(){ return nowFn() >= deadline; }
  let currentPhase = 'init';

  // Phase time allocation (adaptive). Override for largeN to emphasize frontier + stochastic.
  let phaseBudget = { seed: budget*0.12, smallEx: (n<=4? budget*0.15:0), frontier: budget*0.33, stochastic: budget*0.20, genetic: budget*0.10, intensify: budget*0.10, padding: 6 };
  if(largeN){
    phaseBudget = { seed: Math.min(budget*0.05, 220), smallEx: 0, frontier: budget*0.50, stochastic: budget*0.25, genetic: budget*0.08, intensify: budget*0.08, padding: 6 };
  }

  // ---------------- Phase 0 + 1: Initialization + Seed Deterministic Probe ----------------
  currentPhase='seed';
  // basic stats
  const sum = nums.reduce((a,b)=>a+b,0);
  const prod = nums.reduce((a,b)=>a*b,1);
  const maxV = Math.max(...nums); const minV = Math.min(...nums);
  const avg = sum/nums.length;
  const median = nums.slice().sort((a,b)=>a-b)[Math.floor(nums.length/2)];
  const seedExprs = [
    {expression: '('+nums.join('+')+')', value: sum, full:true},
    {expression: '('+nums.join('*')+')', value: prod, full:true},
    {expression: String(maxV), value:maxV, full:false},
    {expression: String(minV), value:minV, full:false},
    {expression: '('+maxV+'-'+minV+')', value: maxV-minV, full:false},
    {expression: '('+maxV+'+'+minV+')', value: maxV+minV, full:false},
    {expression: '('+avg+')', value: avg, full:false},
    {expression: '('+median+')', value: median, full:false}
  ];
  for(const s of seedExprs){ if(!isFinite(s.value)||isNaN(s.value)) continue; if(useIntegerMode && !isIntegerResult(s.value)) continue; if(updateBest(s.expression,s.value, s.full)) return best; }

  // seed DFS (small beam) limited time
  function fast_seedDFS(){
    const localDeadline = start + phaseBudget.seed;
  const ENABLE = { '+': !!operatorFlags['+'], '-': !!operatorFlags['-'], '*': !!operatorFlags['*'], '/': !!operatorFlags['/'], '%': !!operatorFlags['%'], '^': !!operatorFlags['^'], '√': !!operatorFlags['√'], '!': !!operatorFlags['!'], '||': !!operatorFlags['||'], '∑': !!operatorFlags['∑'], 'log': !!operatorFlags['log'], 'ln': !!operatorFlags['ln'] };
    const visited=new Set();
    const QF=1e9; function q(v){ if(!isFinite(v)) return 'X'; return Math.round(v*QF)/QF; }
    function key(arr){ return arr.map(q).sort((a,b)=>a-b).join(','); }
    const allowPower = ENABLE['^'];
    const beamBase = largeN ? Math.max(8, Math.floor(n*1.3)) : Math.max(6, 10 - Math.floor(n/2));
    let expansions=0;
    function tExceeded(){ return nowFn() >= localDeadline || nowFn()>=deadline; }
  function record(val, ast, full){ if(!full) return false; const expr=serializeAST(ast); return updateBest(expr,val, true); }
    function dfs(curNums, curExpr){ if(tExceeded()) return true; const k=key(curNums); if(visited.has(k)) return false; visited.add(k); if(curNums.length===1){ const r=curNums[0]; const e=curExpr[0]; if(usesAllNumbers(e, numsInput)) record(r,e,true); return false; }
      const nL=curNums.length; const pairs=[]; for(let i=0;i<nL-1;i++){ for(let j=i+1;j<nL;j++){ const a=curNums[i], b=curNums[j]; let score=Math.abs((a+b)-target); score=Math.min(score, Math.abs((a*b)-target)); score=Math.min(score, Math.abs((a-b)-target)); score=Math.min(score, Math.abs((b-a)-target)); if(Math.abs(b)>1e-12) score=Math.min(score, Math.abs((a/b)-target)); if(Math.abs(a)>1e-12) score=Math.min(score, Math.abs((b/a)-target)); if(allowPower){ if(!(a===0 && b<=0)) score=Math.min(score, Math.abs(Math.pow(a,b)-target)); if(!(b===0 && a<=0)) score=Math.min(score, Math.abs(Math.pow(b,a)-target)); } pairs.push({i,j,score}); } }
      pairs.sort((x,y)=>x.score-y.score);
      const beam = Math.min(pairs.length, beamBase);
      for(let pi=0; pi<beam; pi++){
        if(tExceeded()) return true;
        const {i,j}=pairs[pi];
        const a=curNums[i], b=curNums[j]; const ea=curExpr[i], eb=curExpr[j];
        const restNums=[]; const restExpr=[]; for(let t=0;t<nL;t++){ if(t!==i && t!==j){ restNums.push(curNums[t]); restExpr.push(curExpr[t]); }}
        const candOps=['+','-','*','/']; if(ENABLE['%']) candOps.push('%'); if(allowPower) candOps.push('^'); if(ENABLE['||']) candOps.push('||'); if(ENABLE['∑']) candOps.push('∑');
        const candidates=[];
        function add(op,x,y,ex,ey){ let val; switch(op){ case '+': val=x+y; break; case '-': val=x-y; break; case '*': val=x*y; break; case '/': val= Math.abs(y)<1e-12? NaN: x/y; break; case '%': val= Math.abs(y)<1e-12? NaN: x - y*Math.floor(x/y); break; case '^': val = (x===0 && y<=0)? NaN: Math.pow(x,y); break; case '||': val = (Number.isInteger(x)&&Number.isInteger(y)&& x>=0 && y>=0)? parseFloat(String(Math.trunc(x))+String(Math.trunc(y))) : NaN; break; case '∑': val = (Number.isInteger(x)&&Number.isInteger(y)&& x<=y)? ((x+y)*(y-x+1)/2) : NaN; break; }
          if(!isFinite(val)||isNaN(val)) return; if(useIntegerMode && !isIntegerResult(val)) return; const diff=Math.abs(val-target); candidates.push({op,val,diff,left:ex,right:ey}); }
        add('+',a,b,ea,eb); add('-',a,b,ea,eb); add('-',b,a,eb,ea); add('*',a,b,ea,eb); add('/',a,b,ea,eb); add('/',b,a,eb,ea);
        if(ENABLE['%']){ add('%',a,b,ea,eb); add('%',b,a,eb,ea);} if(allowPower){ add('^',a,b,ea,eb); add('^',b,a,eb,ea);} if(ENABLE['||']){ add('||',a,b,ea,eb); add('||',b,a,eb,ea);} if(ENABLE['∑']){ add('∑',a,b,ea,eb); add('∑',b,a,eb,ea);} candidates.sort((x,y)=>x.diff-y.diff);
        const cut = Math.min(candidates.length, largeN ? 22 : 14);
        for(let ci=0; ci<cut; ci++){
          if(tExceeded()) return true;
          const c=candidates[ci]; const ast={type:'op',operator:c.op,left:c.left,right:c.right,value:c.val};
          if(nL===2){ if(record(c.val,ast,true)) return true; }
          const nextNums=restNums.concat([c.val]); const nextExpr=restExpr.concat([ast]);
          if(dfs(nextNums,nextExpr)) return true; expansions++; if(best && best.isExact) return true; if(expansions>(largeN?9000:5000) && tExceeded()) return true;
        }
      }
      return false;
    }
    dfs(nums, nums.map(v=>({type:'num',value:v})));
  }
  fast_seedDFS();
  if(best && best.isExact) return best;

  // ---------------- Phase 2: Exhaustive small-n batched (only n<=4) ----------------
  currentPhase='smallEx';
  let smallExState=null;
  function initSmallEx(){ if(n>4) return; // prepare permutations & batching
    const arr=nums.slice();
    const seen=new Set(); const perms=[];
    function permute(a,l){ if(l===a.length){ const key=a.join(','); if(!seen.has(key)){ seen.add(key); perms.push(a.slice()); } return; } for(let i=l;i<a.length;i++){ [a[l],a[i]]=[a[i],a[l]]; permute(a,l+1); [a[l],a[i]]=[a[i],a[l]]; } }
    permute(arr,0);
    smallExState={ perms, idx:0 };
  }
  if(!largeN) initSmallEx();
  function runSmallExBatch(msSlice){ if(!smallExState) return; const sliceDeadline = nowFn()+msSlice; while(nowFn()<sliceDeadline && smallExState.idx < smallExState.perms.length){ const p = smallExState.perms[smallExState.idx++]; const exprs = generateAllGroupings(p,target); for(const ex of exprs){ const val=evaluateAST(ex); if(!isFinite(val)||isNaN(val)) continue; if(!usesAllNumbers(ex,p)) continue; if(updateBest(serializeAST(ex),val)) return true; if(timeExceeded()) return true; } if(best && best.isExact) return true; if(timeExceeded()) return true; }
    return false; }
  if(!largeN && n<=4 && timeLeft()>0 && !best?.isExact){ while(timeLeft()>0 && (nowFn()-start) < phaseBudget.seed + phaseBudget.smallEx && !best?.isExact){ if(runSmallExBatch(3)) break; if(timeLeft()<5) break; }
  }
  if(best && best.isExact) return best;

  // ---------------- Phase 3 (LargeN override): High-throughput layered beam search ----------------
  function largeNBeamSearch(){
    currentPhase='beam';
    const ENABLE = { '+':!!operatorFlags['+'], '-':!!operatorFlags['-'], '*':!!operatorFlags['*'], '/':!!operatorFlags['/'], '%':!!operatorFlags['%'], '^':!!operatorFlags['^'], '||':!!operatorFlags['||'], '∑':!!operatorFlags['∑'] };
    const allowPower = ENABLE['^'];
    const startPhase = nowFn();
    const phaseEnd = start + phaseBudget.seed + phaseBudget.frontier; // allocate frontier budget window
    const BASE_BEAM = Math.min(1800, 320 + n*140 + Math.round(speedAccuracy*600));
    const magnitudeSoft = Math.abs(target)*32 + 2000;
    const pairOpOrder = ['+','*','-','/','%','^','||','∑'];
    const opEnabled = pairOpOrder.filter(o=>ENABLE[o]);
    const transBest = new Map(); // signature -> best diff
    function sig(arr){ return arr.slice().sort((a,b)=>a-b).map(v=>Math.round(v*1e6)/1e6).join(','); }
    function pushNext(container,item,limit){ container.push(item); }
    function expandLayer(states){
      const next=[];
      for(const st of states){ if(timeExceeded()|| nowFn()>phaseEnd) break; const arr=st.arr; const exprs=st.exprs; const L=arr.length; if(L===1){ continue; }
        // heuristic pair ranking: pick top diff-improving pairs only
        const pairScores=[]; for(let i=0;i<L-1;i++){ for(let j=i+1;j<L;j++){ const a=arr[i], b=arr[j]; let score=Math.min(Math.abs((a+b)-target), Math.abs((a*b)-target)); score=Math.min(score, Math.abs((a-b)-target)); score=Math.min(score, Math.abs((b-a)-target)); if(Math.abs(b)>1e-12) score=Math.min(score, Math.abs((a/b)-target)); if(Math.abs(a)>1e-12) score=Math.min(score, Math.abs((b/a)-target)); if(allowPower){ if(!(a===0 && b<=0)) score=Math.min(score, Math.abs(Math.pow(a,b)-target)); if(!(b===0 && a<=0)) score=Math.min(score, Math.abs(Math.pow(b,a)-target)); } pairScores.push({i,j,score}); } }
        pairScores.sort((a,b)=>a.score-b.score);
        const pairLimit = L>=10? 22 : L>=8? 26 : 30;
        for(let p=0; p<Math.min(pairLimit,pairScores.length); p++){
          if(timeExceeded()|| nowFn()>phaseEnd) break;
          const {i,j}=pairScores[p]; const a=arr[i], b=arr[j]; const ea=exprs[i], eb=exprs[j]; const restVals=[]; const restExpr=[]; for(let t=0;t<L;t++){ if(t!==i && t!==j){ restVals.push(arr[t]); restExpr.push(exprs[t]); }}
          const candOps=[]; for(const op of opEnabled){ // add canonical order variants
            if(op==='+'){ candOps.push({op,x: a<=b?a:b, y:a<=b?b:a, ex:a<=b?ea:eb, ey:a<=b?eb:ea}); }
            else if(op==='*'){ candOps.push({op,x: a<=b?a:b, y:a<=b?b:a, ex:a<=b?ea:eb, ey:a<=b?eb:ea}); }
            else if(op==='-'){ candOps.push({op,x:a,y:b,ex:ea,ey:eb}); candOps.push({op,x:b,y:a,ex:eb,ey:ea}); }
            else if(op==='/'){ candOps.push({op,x:a,y:b,ex:ea,ey:eb}); candOps.push({op,x:b,y:a,ex:eb,ey:ea}); }
            else if(op==='%'){ candOps.push({op,x:a,y:b,ex:ea,ey:eb}); candOps.push({op,x:b,y:a,ex:eb,ey:ea}); }
            else if(op==='^'){ candOps.push({op,x:a,y:b,ex:ea,ey:eb}); candOps.push({op,x:b,y:a,ex:eb,ey:ea}); }
            else if(op==='||'){ candOps.push({op,x:a,y:b,ex:ea,ey:eb}); candOps.push({op,x:b,y:a,ex:eb,ey:ea}); }
            else if(op==='∑'){ candOps.push({op,x:a,y:b,ex:ea,ey:eb}); candOps.push({op,x:b,y:a,ex:eb,ey:ea}); }
          }
          const opLimit = 10; // cap per pair after filtering
          const opResults=[];
          for(const c of candOps){ if(opResults.length>=opLimit) break; let val; switch(c.op){ case '+': val=c.x+c.y; break; case '-': val=c.x-c.y; break; case '*': val=c.x*c.y; break; case '/': val=Math.abs(c.y)<1e-12? NaN: c.x/c.y; break; case '%': val=Math.abs(c.y)<1e-12? NaN: c.x - c.y*Math.floor(c.x/c.y); break; case '^': val=(c.x===0 && c.y<=0)? NaN: Math.pow(c.x,c.y); break; case '||': val=(Number.isInteger(c.x)&&Number.isInteger(c.y)&& c.x>=0 && c.y>=0)? parseFloat(String(Math.trunc(c.x))+String(Math.trunc(c.y))):NaN; break; case '∑': val=(Number.isInteger(c.x)&&Number.isInteger(c.y)&& c.x<=c.y)? ((c.x+c.y)*(c.y-c.x+1)/2):NaN; break; }
            if(!isFinite(val)||isNaN(val)) continue; if(useIntegerMode && !isIntegerResult(val)) continue; if(Math.abs(val)>magnitudeSoft && speedAccuracy < 0.95) continue; const diff=Math.abs(val-target); opResults.push({val,diff,op:c.op, left:c.ex, right:c.ey}); }
          opResults.sort((a,b)=>a.diff-b.diff);
          for(let oi=0; oi<opResults.length && oi<opLimit; oi++){
            if(timeExceeded()|| nowFn()>phaseEnd) break;
            const or=opResults[oi]; const ast={type:'op',operator:or.op,left:or.left,right:or.right,value:or.val};
            if(restVals.length===0){ // full expression
              if(updateBest(serializeAST(ast), or.val, true)) return next; continue; }
            let newArr = restVals.concat([or.val]);
            let newExprs = restExpr.concat([ast]);
            // Opportunistic unary only when few numbers left
            if(newArr.length<=4){ if(operatorFlags['√'] && or.val>=0){ let sv=or.val; let depth=0; while(depth<Math.min(1,MAX_SQRT_DEPTH)){ sv=Math.sqrt(sv); if(!isFinite(sv)||isNaN(sv)) break; if(useIntegerMode && !isIntegerResult(sv)) break; const sa={type:'op',operator:'√',left:null,right:ast,value:sv}; newArr = restVals.concat([sv]); newExprs = restExpr.concat([sa]); const diffU=Math.abs(sv-target); if(updateBest(serializeAST(sa),sv)) return next; break; } }
            }
            const newSig = sig(newArr);
            const bestSeen = transBest.get(newSig);
            if(bestSeen!=null && bestSeen <= or.diff) continue; // dominated
            transBest.set(newSig, or.diff);
            next.push({ arr:newArr, exprs:newExprs, score:or.diff });
            if(newArr.length===1){ if(updateBest(serializeAST(newExprs[0]), newArr[0], true)) return next; }
          }
        }
      }
      return next;
    }
    // Iterative layered beam passes with random permutations for diversification
    let passes=0;
    while(!timeExceeded() && nowFn() < phaseEnd && timeLeft()>0){
      passes++;
      const baseOrder = (passes===1)? numsInput.slice() : numsInput.slice().sort(()=>Math.random()-0.5);
      let layerStates=[{ arr: baseOrder.slice(), exprs: baseOrder.map(v=>({type:'num',value:v})), score:Infinity }];
      for(let L=baseOrder.length; L>1 && !timeExceeded() && nowFn()<phaseEnd; L--){
        const expanded = expandLayer(layerStates);
        if(!expanded || expanded.length===0) break;
        expanded.sort((a,b)=>a.score-b.score);
        const beamLimit = Math.max(50, Math.floor(BASE_BEAM / (Math.pow(1.35, (n - L)))));
        layerStates = expanded.slice(0, beamLimit);
        if(best && best.isExact) return; // early exit
      }
      if(best && best.isExact) return;
      if(passes> (speedAccuracy<0.5? 28: 18) ) break;
    }
  }
  if(largeN){ largeNBeamSearch(); if(best && best.isExact) return best; }

  // ---------------- Phase 3: Multi-frontier best-first (SKIPPED for largeN now) ----------------
  if(!largeN){
    currentPhase='frontier';
    const frontierCaps = (function(){ if(!largeN) return { value:1500, diversity:1500, structural:1500 }; const capV=Math.min(6000, 350*n); return { value: capV, diversity: Math.min(capV*0.75, capV), structural: Math.min(capV*0.63, capV) }; })();
    const frontiers = { value:[], diversity:[], structural:[] }; // each item: {nums, exprs, diff, signature, age}
    const signatureBestDiff = new Map(); // signature -> best diff seen
    function signatureOf(arr){ return arr.slice().sort((a,b)=>a-b).map(x=>Math.round(x*1e6)/1e6).join('|')+'#'+arr.length; }
    function pushFrontier(type,item){ const sig=item.signature; if(largeN){ const prev=signatureBestDiff.get(sig); if(prev!=null && prev <= item.diff) return; signatureBestDiff.set(sig,item.diff); } const f=frontiers[type]; f.push(item); if(f.length>frontierCaps[type]) f.sort((a,b)=>a.diff-b.diff), f.length=frontierCaps[type]; }
    (function seedFrontiers(){ const baseExprs=nums.map(v=>({type:'num',value:v})); pushFrontier('value',{nums:nums.slice(), exprs:baseExprs, diff:Infinity, signature:signatureOf(nums), age:0}); })();
    function expandState(state, limitPairs){ const arr=state.nums; const exprs=state.exprs; const nL=arr.length; if(nL<2) return []; const ENABLE = { '+': !!operatorFlags['+'], '-': !!operatorFlags['-'], '*': !!operatorFlags['*'], '/': !!operatorFlags['/'], '%': !!operatorFlags['%'], '^': !!operatorFlags['^'], '||': !!operatorFlags['||'], '∑': !!operatorFlags['∑'] }; const results=[]; for(let i=0;i<nL-1 && results.length<limitPairs;i++){ for(let j=i+1;j<nL && results.length<limitPairs;j++){ const a=arr[i], b=arr[j]; const ea=exprs[i], eb=exprs[j]; const restNums=[]; const restExprs=[]; for(let t=0;t<nL;t++){ if(t!==i && t!==j){ restNums.push(arr[t]); restExprs.push(exprs[t]); }} function add(op,x,y,EX,EY){ let val; switch(op){ case '+': val=x+y; break; case '-': val=x-y; break; case '*': val=x*y; break; case '/': val=Math.abs(y)<1e-12? NaN: x/y; break; case '%': val=Math.abs(y)<1e-12? NaN: x - y*Math.floor(x/y); break; case '^': val=(x===0&&y<=0)?NaN: Math.pow(x,y); break; case '||': val=(Number.isInteger(x)&&Number.isInteger(y)&& x>=0 && y>=0)? parseFloat(String(Math.trunc(x))+String(Math.trunc(y))):NaN; break; case '∑': val=(Number.isInteger(x)&&Number.isInteger(y)&& x<=y)? ((x+y)*(y-x+1)/2):NaN; break; default: val=NaN; } if(!isFinite(val)||isNaN(val)) return; if(useIntegerMode && !isIntegerResult(val)) return; const ast={type:'op',operator:op,left:EX,right:EY,value:val}; const newNums=restNums.concat([val]); const newExprs=restExprs.concat([ast]); const diff=Math.abs(val-target); results.push({nums:newNums, exprs:newExprs, diff, signature:signatureOf(newNums), age:0}); if(newNums.length===1){ if(updateBest(serializeAST(ast),val)) return; } }
        add('+',a,b,ea,eb); add('-',a,b,ea,eb); add('-',b,a,eb,ea); add('*',a,b,ea,eb); add('/',a,b,ea,eb); add('/',b,a,eb,ea); if(ENABLE['%']){ add('%',a,b,ea,eb); add('%',b,a,eb,ea);} if(ENABLE['^']){ add('^',a,b,ea,eb); add('^',b,a,eb,ea);} if(ENABLE['||']){ add('||',a,b,ea,eb); add('||',b,a,eb,ea);} if(ENABLE['∑']){ add('∑',a,b,ea,eb); add('∑',b,a,eb,ea);} }
      }
      return results;
    }
    let stagnationBoost=false; let boostEnd=0; const STAG_THRESHOLD = largeN ? budget*0.08 : budget*0.16;
    function frontierLoop(){ let loops=0; while(!timeExceeded() && timeLeft()>0 && (nowFn()-start) < (phaseBudget.seed+phaseBudget.smallEx+phaseBudget.frontier)){
        loops++; if(best && best.isExact) break;
        if(largeN){
          if(!stagnationBoost && (nowFn()-lastImprovementTime) > STAG_THRESHOLD){ stagnationBoost=true; boostEnd = nowFn() + Math.min(3000, budget*0.15); frontierCaps.value = Math.min(frontierCaps.value*1.4, 8000); frontierCaps.diversity = Math.min(frontierCaps.diversity*1.35, 7000); frontierCaps.structural = Math.min(frontierCaps.structural*1.3, 6500); }
          if(stagnationBoost && nowFn() > boostEnd){ stagnationBoost=false; }
        }
        let pickType='value'; const dv=frontiers.value.length; const dd=frontiers.diversity.length; const ds=frontiers.structural.length; if(dd<dv*0.6) pickType='diversity'; else if(ds<dv*0.5) pickType='structural'; if(frontiers[pickType].length===0){ pickType='value'; if(frontiers.value.length===0) break; }
        const f=frontiers[pickType]; f.sort((a,b)=>a.diff-b.diff); const state=f.shift(); if(!state){ continue; }
        const pairLimit = largeN ? (4 + Math.min(20, Math.floor(n*1.2)) + (stagnationBoost?4:0)) : (4 + Math.min(6, Math.floor(loops/50)));
        const expansions=expandState(state, pairLimit) || [];
        for(const ex of expansions){ pushFrontier('value', ex); if(Math.random()<0.5) pushFrontier('diversity', ex); if(Math.random()<0.35) pushFrontier('structural', ex); }
        if(largeN && loops % 400 ===0){
          for(let r=0;r<5;r++){ const allNums=numsInput.slice(); if(allNums.length<2) break; const i=Math.floor(Math.random()*allNums.length); let j=Math.floor(Math.random()*allNums.length); if(j===i) j=(j+1)%allNums.length; const a=allNums[i], b=allNums[j]; const ea={type:'num',value:a}, eb={type:'num',value:b}; const ops=['+','*','-']; if(operatorFlags['/']) ops.push('/'); if(operatorFlags['^']) ops.push('^'); const op=ops[Math.floor(Math.random()*ops.length)]; let v; switch(op){ case '+': v=a+b; break; case '*': v=a*b; break; case '-': v=a-b; break; case '/': v=Math.abs(b)<1e-12? a: a/b; break; case '^': v=(a===0 && b<=0)? a: Math.pow(a,b); break; } if(!isFinite(v)||isNaN(v)) continue; const ast={type:'op',operator:op,left:ea,right:eb,value:v}; const newNums=allNums.filter((_,idx)=>idx!==i && idx!==j).concat([v]); const newExprs=newNums.map(val=>({type:'num',value:val}));
            pushFrontier('diversity',{nums:newNums, exprs:newExprs, diff:Math.abs(v-target), signature:signatureOf(newNums), age:0}); }
        }
        if(loops%200===0 && best) postProgress(best);
        if(loops> (largeN? 180000:60000)) break; }
    }
    frontierLoop();
    if(best && best.isExact) return best;
  }

  if(best && best.isExact) return best;

  // ---------------- Phase 4: Stochastic Portfolio ----------------
  currentPhase='stochastic';
  function mcBuild(iterLimit){ const base=numsInput.slice(); let attempts=0; while(attempts<iterLimit && !timeExceeded()){ attempts++; let order=base.slice().sort(()=>Math.random()-0.5); let exprStack=order.map(v=>({type:'num',value:v})); let valStack=order.slice(); while(valStack.length>1){
        let i=0,j=1; if(largeN){
          const L=valStack.length; let bestVar=null, bestGreedy=null; 
          for(let a=0;a<L;a++){ for(let b=a+1;b<L;b++){ const va=valStack[a], vb=valStack[b]; const diff=Math.abs(va-vb); if(!bestVar || diff>bestVar.diff) bestVar={a,b,diff}; const gScore=Math.min(Math.abs((va+vb)-target), Math.abs(va*vb-target)); if(!bestGreedy || gScore<bestGreedy.score) bestGreedy={a,b,score:gScore}; } }
          const rnd=Math.random(); if(rnd<0.5 && bestVar){ i=bestVar.a; j=bestVar.b; } else if(rnd<0.8 && bestGreedy){ i=bestGreedy.a; j=bestGreedy.b; } else { i=Math.floor(Math.random()*L); j=i; while(j===i) j=Math.floor(Math.random()*L); if(i>j){ const tmp=i; i=j; j=tmp; } }
        } else {
          let bestPair=null; for(let a=0;a<valStack.length;a++){ for(let b=a+1;b<valStack.length;b++){ const A=valStack[a], B=valStack[b]; const score=Math.min(Math.abs(A+B-target), Math.abs(A*B-target)); if(!bestPair || score<bestPair.score) bestPair={i:a,j:b,score}; } } i=bestPair.i; j=bestPair.j; }
        const a=valStack[i], b=valStack[j]; const ea=exprStack[i], eb=exprStack[j]; valStack.splice(j,1); exprStack.splice(j,1); valStack.splice(i,1); exprStack.splice(i,1);
        const ops=['+','*','-']; if(operatorFlags['/']) ops.push('/'); if(operatorFlags['^']) ops.push('^'); const op=ops[Math.floor(Math.random()*ops.length)]; let r; switch(op){ case '+': r=a+b; break; case '*': r=a*b; break; case '-': r=a-b; break; case '/': r=Math.abs(b)<1e-12? a: a/b; break; case '^': r=(a===0 && b<=0)? a: Math.pow(a,b); break; } if(!isFinite(r)||isNaN(r)){ r=a+b; }
        const node={type:'op',operator:op,left:ea,right:eb,value:r}; valStack.push(r); exprStack.push(node); if(valStack.length===1){ if(updateBest(serializeAST(node), r)) return; }
        if(timeExceeded()) return; }
    }
  }
  function anneal(iterLimit){ if(!best) return; let T=1.0; const startT=nowFn(); for(let k=0;k<iterLimit && !timeExceeded(); k++){ T = Math.max(0.01, 1 - (nowFn()-startT)/(phaseBudget.stochastic)); const exprAST=parseExpressionToAST(best.expression); if(!exprAST) return; const mutant=mutateAST(exprAST); if(!mutant) continue; const val=evaluateAST(mutant); if(!isFinite(val)||isNaN(val)) continue; const diff=Math.abs(val-target); if(diff < best.diff || Math.random() < Math.exp((best.diff-diff)/(T*5))){ updateBest(serializeAST(mutant), val); if(best.isExact) return; } }
  }
  function hill(iterLimit){ if(!best) return; for(let k=0;k<iterLimit && !timeExceeded(); k++){ const exprAST=parseExpressionToAST(best.expression); const m=mutateAST(exprAST); if(!m) continue; const val=evaluateAST(m); if(!isFinite(val)||isNaN(val)) continue; if(Math.abs(val-target) < best.diff){ if(updateBest(serializeAST(m),val)) return; } }
  }
  function parseExpressionToAST(expr){ try { return null; } catch{ return null; } }
  function mutateAST(ast){ if(!ast || ast.type==='num') return null; const clone = JSON.parse(JSON.stringify(ast)); const flip={'+':'-','-':'+','*':'/','/':'*','^':'*'}; if(flip[clone.operator]) clone.operator=flip[clone.operator]; return clone; }
  let stochSlices=0; while(!timeExceeded() && timeLeft()>0 && (nowFn()-start) < (phaseBudget.seed+phaseBudget.smallEx+phaseBudget.frontier+phaseBudget.stochastic) && !(best&&best.isExact)){ mcBuild(largeN?4:2); hill(largeN?4:10); anneal(largeN?2:4); stochSlices++; if(stochSlices> (largeN?8000:4000)) break; }
  if(best && best.isExact) return best;

  // ---------------- Phase 5: Genetic (simplified placeholder) ----------------
  currentPhase='genetic';
  function geneticSimple(){ if(timeExceeded()) return; if(!best) return; for(let g=0; g< (largeN?80:40) && !timeExceeded(); g++){ mcBuild(1); if(best && best.isExact) return; } }
  if(timeLeft() > budget*0.20 && !best?.isExact){ geneticSimple(); }
  if(best && best.isExact) return best;

  // ---------------- Phase 6: Intensification ----------------
  currentPhase='intensify';
  function intensify(){ if(!best) return; for(let i=0;i< (largeN?800:500) && !timeExceeded(); i++){ hill(4); if(best && best.isExact) return; } }
  intensify();
  if(best && best.isExact) return best;

  // ---------------- Phase 7: Padding ----------------
  currentPhase='padding';
  while(!timeExceeded() && timeLeft()>0){ mcBuild(1); if(best && best.isExact) break; if(timeLeft()<3) break; }

  return best;
}
// -----------------------------------------------------------------------------

self.onmessage = function(e){ const data=e.data; operatorFlags=data.operatorFlags; useIntegerMode=data.useIntegerMode; MAX_SQRT_DEPTH=data.MAX_SQRT_DEPTH; MAX_FACT_DEPTH=data.MAX_FACT_DEPTH; MAX_LOG_DEPTH=data.MAX_LOG_DEPTH||1; MAX_LN_DEPTH=data.MAX_LN_DEPTH||1; MAX_FACTORIAL_INPUT=data.MAX_FACTORIAL_INPUT; MAX_RESULTS=data.MAX_RESULTS||Infinity; if(typeof data.speedAccuracy==='number') speedAccuracy=Math.max(0,Math.min(1,data.speedAccuracy)); if(typeof data.timeBudgetMs==='number') externalTimeBudgetMs = Math.max(50, Math.min(20000, data.timeBudgetMs)); else externalTimeBudgetMs=null;
  if(data.type==='findFirstFast'){
    // New anytime orchestrator
    calculationCache.clear(); opResultCache.clear(); factorialCache.clear(); lastProgressPost=0;
    const { nums, target } = data;
  const best = fast_runAnytime(nums, target, !!data.allowPartial);
    if(best){ if(best.isExact){ self.postMessage({ found:true, expression:best.expression, result:best.result }); } else { self.postMessage({ found:false, closest: best, timedOut: false }); } } else { self.postMessage({ found:false, finished:true }); }
  } else if(data.type==='findAll' || data.type==='findAllRange') {
    // retain existing exhaustive modes (unchanged structural logic) -- can reuse from previous version
    const { permutations, start, end, target, nums, chunk } = data; const EXACT = EXACT_EPS; let results=[]; let expressionSet=new Set(); let closestResult=null; let smallestDiff=Infinity; calculationCache.clear(); expressionCache.clear(); opResultCache.clear();
    function processExpression(ast){ const result=evaluateAST(ast); if(!isFinite(result)||isNaN(result)) return; const diff=Math.abs(result-target); if(usesAllNumbers(ast,nums)){ if(diff<smallestDiff){ smallestDiff=diff; closestResult={ expression:serializeAST(ast), result, diff, isExact: diff<=EXACT }; postProgress(closestResult); } if(diff<=EXACT){ const canonicalAST=canonicalizeAST(ast); const canonicalStr=serializeAST(canonicalAST); if(!expressionSet.has(canonicalStr)){ expressionSet.add(canonicalStr); results.push({ expression: canonicalStr, result }); } } } }
    try { if(data.type==='findAllRange'){ for(let p=start; p<end; p++){ const perm=permutations[p]; const expressions=generateAllGroupings(perm,target); if(!Array.isArray(expressions)) continue; for(let i=0;i<expressions.length;i++){ processExpression(expressions[i]); } } } else { for(let p=0;p<chunk.length;p++){ const perm=chunk[p]; const expressions=generateAllGroupings(perm,target); if(!Array.isArray(expressions)) continue; for(let i=0;i<expressions.length;i++){ processExpression(expressions[i]); } } } self.postMessage({ results, closest: closestResult || null }); } catch(err){ self.postMessage({ results, closest: closestResult || null, error: err.message }); }
  } else if(data.type==='findAllSubsetsRange') {
    // NEW: subset mode range evaluation. permutations is array of arrays (each its own base set)
    const { permutations, start, end, target } = data;
    let results=[]; let closestResult=null; let smallestDiff=Infinity; const EXACT = EXACT_EPS;
    const globalExprSet=new Set();
    function permuteList(arr){ const res=[]; const a=arr.slice(); const c=new Array(a.length).fill(0); res.push(a.slice()); let i=1; while(i<a.length){ if(c[i]<i){ const k = i % 2 ? c[i] : 0; [a[i],a[k]]=[a[k],a[i]]; res.push(a.slice()); c[i]++; i=1; } else { c[i]=0; i++; } } return res; }
    function processSubset(perm){
      // Enumerate permutations to maintain same completeness as full-set exhaustive.
      const perms = permuteList(perm);
      for(const p of perms){
        const expressions=generateAllGroupings(p,target); if(!Array.isArray(expressions)) continue;
        for(const ex of expressions){ const val=evaluateAST(ex); if(!isFinite(val)||isNaN(val)) continue; const diff=Math.abs(val-target); if(diff < smallestDiff){ smallestDiff=diff; closestResult={ expression: serializeAST(ex), result: val, diff, isExact: diff<=EXACT_EPS }; postProgress(closestResult); }
          if(diff<=EXACT){ const canonicalAST=canonicalizeAST(ex); const canonicalStr=serializeAST(canonicalAST); if(!globalExprSet.has(canonicalStr)){ globalExprSet.add(canonicalStr); results.push({ expression: canonicalStr, result: val, subsetSize: perm.length }); if(results.length >= MAX_RESULTS) return; } }
        }
        if(results.length >= MAX_RESULTS) return; if(externalTimeBudgetMs!=null && results.length < MAX_RESULTS){ /* time budget not enforced here; could add if needed */ }
      }
    }
    try {
      for(let p=start; p<end; p++){ processSubset(permutations[p]); }
      self.postMessage({ results, closest: closestResult || null });
    } catch(err){ self.postMessage({ results, closest: closestResult || null, error: err.message }); }
  } else if(data.type==='analyzeRange'){
    // Analyze mode: aggregate integer results that fall within [minTarget..maxTarget]
    const { permutations, start, end, minTarget, maxTarget } = data;
    const valueMap = new Map(); // v -> Set(expressions)
    calculationCache.clear(); expressionCache.clear(); opResultCache.clear(); factorialCache.clear();
    const EXACT = EXACT_EPS;
    function isNearIntegerStrict(x){ const r=Math.round(x); return Math.abs(x - r) <= EXACT_EPS; }
    function addExpr(val, ast){
      if(!Number.isFinite(val)) return; // only finite values
      // strict integer check for analyze mode (exclude near-misses like sqrt(2401 - ε))
      if(!isNearIntegerStrict(val)) return;
      const v = Math.round(val);
      if(v < minTarget || v > maxTarget) return;
      const canonicalAST = canonicalizeAST(ast);
      const exprStr = serializeAST(canonicalAST);
      let set = valueMap.get(v);
      if(!set){ set = new Set(); valueMap.set(v, set); }
      set.add(exprStr);
    }
    try {
      let processed = 0; const postEvery = 1;
      for(let p=start; p<end; p++){
        const perm = permutations[p];
        const expressions = generateAllGroupings(perm, 0);
        if(Array.isArray(expressions)){
          for(let i=0;i<expressions.length;i++){
            const ex = expressions[i];
            const val = evaluateAST(ex);
            if(!isFinite(val) || isNaN(val)) continue;
            addExpr(val, ex);
          }
        }
        processed++;
        if(processed % postEvery === 0){
          self.postMessage({ progress:true, processed });
        }
      }
      // convert to transportable array
      const analysis = Array.from(valueMap.entries()).map(([value,set])=>({ value, expressions: Array.from(set) }));
      self.postMessage({ analysis });
    } catch(err){ self.postMessage({ analysis: Array.from(valueMap.entries()).map(([value,set])=>({ value, expressions:Array.from(set) })), error: err.message }); }
  }
};