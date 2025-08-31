// Import WebAssembly math module
importScripts('./wasm-math.js');

// Core variables
let operatorFlags = {};
let useIntegerMode = false;
let MAX_SQRT_DEPTH = 2;
let MAX_FACT_DEPTH = 1;
let MAX_FACTORIAL_INPUT = 10;
let MAX_RESULTS = 100;
const EXACT_EPS = 1e-12;

const factorialCache = new Map();
const calculationCache = new Map();
const expressionCache = new Map();

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
  if (!isNaN(result)) { if (calculationCache.size>1000000) calculationCache.clear(); calculationCache.set(cacheKey,result); }
  return result;
}

function isIntegerResult(r){ return Number.isInteger(r) || Math.abs(r - Math.round(r)) < 0.0001; }
function serializeAST(node){ if(node.type==='num') return node.value.toString(); if(node.operator==='√') return `√(${serializeAST(node.right)})`; if(node.operator==='!') return `(${serializeAST(node.right)})!`; return `(${node.left?serializeAST(node.left):''} ${node.operator} ${serializeAST(node.right)})`; }
function canonicalizeAST(node){ if(node.type==='num') return node; let left=node.left?canonicalizeAST(node.left):null; let right=canonicalizeAST(node.right); if(node.operator==='+'||node.operator==='*'||node.operator==='%'){ let ls=serializeAST(left), rs=serializeAST(right); if(ls>rs) return {type:'op',operator:node.operator,left:right,right:left}; } return {type:'op',operator:node.operator,left,right}; }
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
          for(const right of rightExprs){
            const ops=[]; if(operatorFlags['+']) ops.push('+'); if(operatorFlags['-']) ops.push('-'); if(operatorFlags['*']) ops.push('*'); if(operatorFlags['/']) ops.push('/'); if(operatorFlags['%']) ops.push('%'); if(operatorFlags['^']) ops.push('^');
            for(const op of ops){
              if(op==='/' && evaluateAST(right)===0) continue;
              if(op==='%' && evaluateAST(right)===0) continue;
              if(op==='^' && evaluateAST(left)===0 && evaluateAST(right)<=0) continue;
              const newExpr={type:'op',operator:op,left,right};
              const val=evaluateAST(newExpr); if(isNaN(val)) continue;
              if(!useIntegerMode || isIntegerResult(val)){
                res.push(newExpr);
                if(operatorFlags['√'] && getSqrtDepth(newExpr) < MAX_SQRT_DEPTH){
                  const v=evaluateAST(newExpr); if(!isNaN(v) && v>=0){ let cur=newExpr; for(let d=1; d<= MAX_SQRT_DEPTH - getSqrtDepth(newExpr); d++){ cur={type:'op',operator:'√',left:null,right:cur}; const sv=evaluateAST(cur); if(!isNaN(sv) && (!useIntegerMode || isIntegerResult(sv))) res.push(cur);} }}
                if(operatorFlags['!'] && getFactDepth(newExpr) < MAX_FACT_DEPTH){
                  const fv=evaluateAST(newExpr); if(!isNaN(fv) && fv>=0 && fv <= MAX_FACTORIAL_INPUT && Number.isInteger(fv)){ let cur=newExpr; for(let d=1; d<= MAX_FACT_DEPTH - getFactDepth(newExpr); d++){ cur={type:'op',operator:'!',left:null,right:cur}; const fr=evaluateAST(cur); if(!isNaN(fr)) res.push(cur);} }}
              }
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

function dfsFindClosest(nums,target,used,exprs,closest){
  const visited=new Set(); const Q_FACTOR=1e9; function quantize(v){ if(!isFinite(v)) return 'X'; return Math.round(v*Q_FACTOR)/Q_FACTOR;} function makeKey(arr){ return arr.map(quantize).sort((a,b)=>a-b).join(','); }
  let found=null;
  function dfs(currentNums,currentExprs){
    const key=makeKey(currentNums); if(visited.has(key)) return false; visited.add(key);
    if(currentNums.length===1){ const result=currentNums[0]; const expr=currentExprs[0]; const diff=Math.abs(result-target); if(diff <= EXACT_EPS){ found={expression:serializeAST(expr), result, diff, isExact:true}; return true;} if(!closest.value || diff < closest.value.diff){ closest.value={expression:serializeAST(expr), result, diff, isExact:false}; } return false; }
    const n=currentNums.length;
    for(let i=0;i<n-1;i++) for(let j=i+1;j<n;j++){
      const a=currentNums[i], b=currentNums[j]; const exprA=currentExprs[i], exprB=currentExprs[j];
      const baseNums=[]; const baseExprs=[]; for(let k=0;k<n;k++){ if(k!==i && k!==j){ baseNums.push(currentNums[k]); baseExprs.push(currentExprs[k]); }}
      const candidates=[]; function pushCandidate(op,la,rb,ea,eb){ let val; switch(op){ case '+': val=la+rb; break; case '-': val=la-rb; break; case '*': val=la*rb; break; case '/': val= Math.abs(rb) < 1e-12 ? NaN : la/rb; break; case '%': val= Math.abs(rb) < 1e-12 ? NaN : la - rb * Math.floor(la/rb); break; case '^': val = (la===0 && rb<=0)? NaN : Math.pow(la,rb); break; default: val=NaN; } if(isNaN(val)||!isFinite(val)) return; if(Math.abs(val)>1e9) return; if(useIntegerMode && !isIntegerResult(val)) return; const diff=Math.abs(val-target); candidates.push({op,val,diff,leftExpr:ea,rightExpr:eb}); }
      if(operatorFlags['+']) pushCandidate('+',a,b,exprA,exprB);
      if(operatorFlags['-']){ pushCandidate('-',a,b,exprA,exprB); pushCandidate('-',b,a,exprB,exprA); }
      if(operatorFlags['*']) pushCandidate('*',a,b,exprA,exprB);
      if(operatorFlags['/']){ pushCandidate('/',a,b,exprA,exprB); pushCandidate('/',b,a,exprB,exprA); }
      if(operatorFlags['%']){ pushCandidate('%',a,b,exprA,exprB); pushCandidate('%',b,a,exprB,exprA); }
      if(operatorFlags['^']){ pushCandidate('^',a,b,exprA,exprB); pushCandidate('^',b,a,exprB,exprA); }
      candidates.sort((x,y)=>x.diff-y.diff);
      for(const cand of candidates){
        const ast={type:'op',operator:cand.op,left:cand.leftExpr,right:cand.rightExpr};
        const variants=[{ast,val:cand.val}];
        if(operatorFlags['√'] && cand.val>=0 && MAX_SQRT_DEPTH>0){ let sv=cand.val; let sa=ast; let d=0; while(d<MAX_SQRT_DEPTH){ sv=Math.sqrt(sv); if(isNaN(sv)||!isFinite(sv)) break; if(useIntegerMode && !isIntegerResult(sv)) break; sa={type:'op',operator:'√',left:null,right:sa}; variants.push({ast:sa,val:sv}); d++; } }
        if(operatorFlags['!'] && cand.val>=0 && cand.val<=MAX_FACTORIAL_INPUT && Number.isInteger(cand.val) && MAX_FACT_DEPTH>0){ let fv=cand.val; let fa=ast; let d=0; while(d<MAX_FACT_DEPTH){ fv=factorial(fv); if(isNaN(fv)||!isFinite(fv)) break; fa={type:'op',operator:'!',left:null,right:fa}; variants.push({ast:fa,val:fv}); d++; } }
        for(const variant of variants){ const valV=variant.val; if(useIntegerMode && !isIntegerResult(valV)) continue; const nextNums=baseNums.concat([valV]); const nextExprs=baseExprs.concat([variant.ast]); if(Math.abs(valV - target) <= EXACT_EPS){ found={expression:serializeAST(variant.ast), result:valV, diff:0, isExact:true}; return true;} const diff=Math.abs(valV-target); if(!closest.value || diff < closest.value.diff){ closest.value={expression:serializeAST(variant.ast), result:valV, diff, isExact:false}; } if(dfs(nextNums,nextExprs)) return true; }
      }
    }
    return false;
  }
  dfs(nums,exprs); return found;
}

self.onmessage = function(e){
  const data=e.data; operatorFlags=data.operatorFlags; useIntegerMode=data.useIntegerMode; MAX_SQRT_DEPTH=data.MAX_SQRT_DEPTH; MAX_FACT_DEPTH=data.MAX_FACT_DEPTH; MAX_FACTORIAL_INPUT=data.MAX_FACTORIAL_INPUT; MAX_RESULTS=data.MAX_RESULTS || Infinity;
  if(data.type==='findFirstFast'){
    const { nums, target } = data; calculationCache.clear(); let closest={ value:null }; let found=dfsFindClosest(nums,target,[], nums.map(n=>({type:'num',value:n})), closest); if(found){ self.postMessage({found:true, expression:found.expression, result:found.result}); return;} if(closest.value){ self.postMessage({found:false, closest:closest.value}); } else { self.postMessage({found:false, finished:true}); } return;
  } else if (data.type==='findAll') {
    const { chunk, target, nums } = data; let results=[]; let expressionSet=new Set(); let closestResult = null; let smallestDiff = Infinity; calculationCache.clear(); expressionCache.clear();
    try { for(let p=0;p<chunk.length;p++){ const perm=chunk[p]; const expressions=generateAllGroupings(perm,target); if(!Array.isArray(expressions)) continue; for(let i=0;i<expressions.length;i++){ const ast=expressions[i]; const result=evaluateAST(ast); if(!isNaN(result)){ const diff=Math.abs(result-target); if(usesAllNumbers(ast,nums)){ if(diff < smallestDiff){ smallestDiff=diff; closestResult={ expression:serializeAST(ast), result, diff, isExact: diff <= EXACT_EPS }; self.postMessage({progress:true, processed:(p+1), closest:closestResult}); } if(diff <= EXACT_EPS){ const canonicalAST=canonicalizeAST(ast); const canonicalStr=serializeAST(canonicalAST); if(!expressionSet.has(canonicalStr)){ expressionSet.add(canonicalStr); results.push({ expression: canonicalStr, result }); } } } } if(i % 100 === 0){ self.postMessage({progress:true, processed:(p+1), closest:closestResult}); } } } self.postMessage({ results, closest: closestResult || null }); }
    catch(err){ self.postMessage({ results, closest: closestResult || null, error: err.message }); return; }
    calculationCache.clear(); expressionCache.clear();
  } else if (data.type==='findAllRange') {
    const { permutations, start, end, target, nums } = data; let results=[]; let expressionSet=new Set(); let closestResult = null; let smallestDiff = Infinity; calculationCache.clear(); expressionCache.clear();
    try { for(let p=start; p<end; p++){ const perm=permutations[p]; const expressions=generateAllGroupings(perm,target); if(!Array.isArray(expressions)) continue; for(let i=0;i<expressions.length;i++){ const ast=expressions[i]; const result=evaluateAST(ast); if(!isNaN(result)){ const diff=Math.abs(result-target); if(usesAllNumbers(ast,nums)){ if(diff < smallestDiff){ smallestDiff=diff; closestResult={ expression:serializeAST(ast), result, diff, isExact: diff <= EXACT_EPS }; self.postMessage({progress:true, processed:(p-start+1), closest:closestResult}); } if(diff <= EXACT_EPS){ const canonicalAST=canonicalizeAST(ast); const canonicalStr=serializeAST(canonicalAST); if(!expressionSet.has(canonicalStr)){ expressionSet.add(canonicalStr); results.push({ expression: canonicalStr, result }); } } } } if(i % 100 === 0){ self.postMessage({progress:true, processed:(p-start+1), closest:closestResult}); } } } self.postMessage({ results, closest: closestResult || null }); }
    catch(err){ self.postMessage({ results, closest: closestResult || null, error: err.message }); return; }
    calculationCache.clear(); expressionCache.clear();
  }
};