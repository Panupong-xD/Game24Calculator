// Core variables
let operatorFlags = {};
let useIntegerMode = false;
let MAX_SQRT_DEPTH = 2;
let MAX_FACT_DEPTH = 1;
let MAX_FACTORIAL_INPUT = 10;
let MAX_RESULTS = 100;

const factorialCache = new Map();
const calculationCache = new Map();
const expressionCache = new Map();

function factorial(n) {
  if (n < 0 || n > MAX_FACTORIAL_INPUT || !Number.isInteger(n)) return NaN;
  if (n === 0 || n === 1) return 1;
  if (factorialCache.has(n)) return factorialCache.get(n);
  let result = 1;
  for (let i = 2; i <= n; i++) result *= i;
  factorialCache.set(n, result);
  return result;
}

function evaluateAST(node) {
  if (node.type === "num") return node.value;
  let leftVal = node.left ? evaluateAST(node.left) : null;
  let rightVal = evaluateAST(node.right);
  const cacheKey = `${node.operator}|${leftVal}|${rightVal}`;
  if (calculationCache.has(cacheKey)) return calculationCache.get(cacheKey);
  let result;
  switch (node.operator) {
    case "+": result = operatorFlags['+'] ? leftVal + rightVal : NaN; break;
    case "-": result = operatorFlags['-'] ? leftVal - rightVal : NaN; break;
    case "*": result = operatorFlags['*'] ? leftVal * rightVal : NaN; break;
    case "/": result = operatorFlags['/'] && rightVal !== 0 ? leftVal / rightVal : NaN; break;
    case "%":
      if (!operatorFlags['%'] || rightVal === 0) return NaN;
      result = leftVal - rightVal * Math.floor(leftVal / rightVal);
      break;
    case "^":
      if (!operatorFlags['^']) return NaN;
      result = (leftVal === 0 && rightVal <= 0) ? (rightVal === 0 ? 1 : NaN) : Math.pow(leftVal, rightVal);
      break;
    case "√": result = operatorFlags['√'] && rightVal >= 0 ? Math.sqrt(rightVal) : NaN; break;
    case "!": result = operatorFlags['!'] && rightVal <= MAX_FACTORIAL_INPUT && rightVal >= 0 && Number.isInteger(rightVal) ? factorial(rightVal) : NaN; break;
    default: return NaN;
  }
  if (!isNaN(result)) {
    if (calculationCache.size > 1000000) calculationCache.clear();
    calculationCache.set(cacheKey, result);
  }
  return result;
}

function isIntegerResult(result) {
  return Number.isInteger(result) || Math.abs(result - Math.round(result)) < 0.0001;
}

function serializeAST(node) {
  if (node.type === "num") return node.value.toString();
  if (node.operator === "√") return `√(${serializeAST(node.right)})`;
  if (node.operator === "!") return `(${serializeAST(node.right)})!`;
  return `(${node.left ? serializeAST(node.left) : ""} ${node.operator} ${serializeAST(node.right)})`;
}

function canonicalizeAST(node) {
  if (node.type === "num") return node;
  let left = node.left ? canonicalizeAST(node.left) : null;
  let right = canonicalizeAST(node.right);
  if (node.operator === "+" || node.operator === "*" || node.operator === "%") {
    let leftStr = serializeAST(left);
    let rightStr = serializeAST(right);
    if (leftStr > rightStr) return { type: "op", operator: node.operator, left: right, right: left };
  }
  return { type: "op", operator: node.operator, left, right };
}

function getSqrtDepth(node) {
  if (node.type === "num") return 0;
  if (node.operator === "√") return 1 + getSqrtDepth(node.right);
  let leftDepth = node.left ? getSqrtDepth(node.left) : 0;
  let rightDepth = node.right ? getSqrtDepth(node.right) : 0;
  return Math.max(leftDepth, rightDepth);
}

function getFactDepth(node) {
  if (node.type === "num") return 0;
  if (node.operator === "!") return 1 + getFactDepth(node.right);
  let leftDepth = node.left ? getFactDepth(node.left) : 0;
  let rightDepth = node.right ? getFactDepth(node.right) : 0;
  return Math.max(leftDepth, rightDepth);
}

function generateAllGroupings(nums, target) {
  const memoized = new Map();
  function generateGroupingsHelper(start, end) {
    const key = `${start}-${end}`;
    if (memoized.has(key)) return memoized.get(key);
    const result = [];
    if (start === end) {
      const numNode = { type: "num", value: nums[start] };
      result.push(numNode);
      if (operatorFlags['√'] && nums[start] >= 0 && (!useIntegerMode || Number.isInteger(Math.sqrt(nums[start])))) {
        let currentExpr = numNode;
        for (let i = 1; i <= MAX_SQRT_DEPTH && operatorFlags['√']; i++) {
          currentExpr = { type: "op", operator: "√", left: null, right: currentExpr };
          const sqrtResult = evaluateAST(currentExpr);
          if (!isNaN(sqrtResult) && (!useIntegerMode || isIntegerResult(sqrtResult))) result.push(currentExpr);
        }
      }
      if (operatorFlags['!'] && nums[start] >= 0 && nums[start] <= MAX_FACTORIAL_INPUT && Number.isInteger(nums[start])) {
        let currentExpr = numNode;
        for (let i = 1; i <= MAX_FACT_DEPTH && operatorFlags['!']; i++) {
          currentExpr = { type: "op", operator: "!", left: null, right: currentExpr };
          const factResult = evaluateAST(currentExpr);
          if (!isNaN(factResult)) result.push(currentExpr);
        }
      }
    } else {
      for (let i = start; i < end; i++) {
        const leftExprs = generateGroupingsHelper(start, i);
        const rightExprs = generateGroupingsHelper(i + 1, end);
        if (!Array.isArray(leftExprs) || !Array.isArray(rightExprs)) continue;
        for (const left of leftExprs) {
          for (const right of rightExprs) {
            const operators = [];
            if (operatorFlags['+']) operators.push("+");
            if (operatorFlags['-']) operators.push("-");
            if (operatorFlags['*']) operators.push("*");
            if (operatorFlags['/']) operators.push("/");
            if (operatorFlags['%']) operators.push("%");
            if (operatorFlags['^']) operators.push("^");
            for (const op of operators) {
              if (op === "/" && evaluateAST(right) === 0) continue;
              if (op === "%" && evaluateAST(right) === 0) continue;
              if (op === "^" && evaluateAST(left) === 0 && evaluateAST(right) <= 0) continue;
              const newExpr = { type: "op", operator: op, left, right };
              const resultVal = evaluateAST(newExpr);
              if (isNaN(resultVal)) continue;

              if (!useIntegerMode || isIntegerResult(resultVal)) {
                result.push(newExpr);
                if (operatorFlags['√'] && getSqrtDepth(newExpr) < MAX_SQRT_DEPTH) {
                  const sqrtValue = evaluateAST(newExpr);
                  if (!isNaN(sqrtValue) && sqrtValue >= 0) {
                    let currentExpr = newExpr;
                    for (let depth = 1; depth <= MAX_SQRT_DEPTH - getSqrtDepth(newExpr); depth++) {
                      currentExpr = { type: "op", operator: "√", left: null, right: currentExpr };
                      const sqrtResult = evaluateAST(currentExpr);
                      if (!isNaN(sqrtResult) && (!useIntegerMode || isIntegerResult(sqrtResult))) {
                        result.push(currentExpr);
                      }
                    }
                  }
                }
                if (operatorFlags['!'] && getFactDepth(newExpr) < MAX_FACT_DEPTH) {
                  const factValue = evaluateAST(newExpr);
                  if (!isNaN(factValue) && factValue >= 0 && factValue <= MAX_FACTORIAL_INPUT && Number.isInteger(factValue)) {
                    let currentExpr = newExpr;
                    for (let depth = 1; depth <= MAX_FACT_DEPTH - getFactDepth(newExpr); depth++) {
                      currentExpr = { type: "op", operator: "!", left: null, right: currentExpr };
                      const factResult = evaluateAST(currentExpr);
                      if (!isNaN(factResult)) result.push(currentExpr);
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    memoized.set(key, result);
    return result;
  }
  return generateGroupingsHelper(0, nums.length - 1);
}

function usesAllNumbers(ast, originalNums) {
  const numbers = [];
  function extractNumbers(node) {
    if (node.type === "num") numbers.push(node.value);
    if (node.left) extractNumbers(node.left);
    if (node.right) extractNumbers(node.right);
  }
  extractNumbers(ast);
  if (numbers.length !== originalNums.length) return false;
  const sortedUsed = [...numbers].sort((a, b) => a - b);
  const sortedOriginal = [...originalNums].sort((a, b) => a - b);
  return sortedUsed.every((val, i) => val === sortedOriginal[i]);
}

function dfsFindClosest(nums, target, used, exprs, closest) {
  let n = nums.length;
  let found = null;

  function dfs(currentNums, currentExprs) {
    if (currentNums.length === 1) {
      const result = currentNums[0];
      const expr = currentExprs[0];
      const diff = Math.abs(result - target);
      if (diff < 0.0001) {
        found = { expression: serializeAST(expr), result, diff, isExact: true };
        return true;
      }
      if (!closest.value || diff < closest.value.diff) {
        closest.value = { expression: serializeAST(expr), result, diff, isExact: false };
      }
      return false;
    }

    for (let i = 0; i < currentNums.length; i++) {
      for (let j = 0; j < currentNums.length; j++) {
        if (i === j) continue;
        let nextNums = [];
        let nextExprs = [];
        for (let k = 0; k < currentNums.length; k++) {
          if (k !== i && k !== j) {
            nextNums.push(currentNums[k]);
            nextExprs.push(currentExprs[k]);
          }
        }
        // ลองทุก operator
        const a = currentNums[i], b = currentNums[j];
        const exprA = currentExprs[i], exprB = currentExprs[j];
        const ops = [];
        if (operatorFlags['+']) ops.push("+");
        if (operatorFlags['-']) ops.push("-");
        if (operatorFlags['*']) ops.push("*");
        if (operatorFlags['/']) ops.push("/");
        if (operatorFlags['%']) ops.push("%");
        if (operatorFlags['^']) ops.push("^");
        for (const op of ops) {
          // ป้องกัน division/mod by zero, pow 0^neg
          if ((op === "/" || op === "%") && Math.abs(b) < 1e-8) continue;
          if (op === "^" && a === 0 && b <= 0) continue;
          let val;
          switch (op) {
            case "+": val = a + b; break;
            case "-": val = a - b; break;
            case "*": val = a * b; break;
            case "/": val = a / b; break;
            case "%": val = a - b * Math.floor(a / b); break;
            case "^": val = Math.pow(a, b); break;
          }
          if (isNaN(val) || !isFinite(val)) continue;
          if (useIntegerMode && !isIntegerResult(val)) continue;

          // สร้าง AST
          const ast = { type: "op", operator: op, left: exprA, right: exprB };
          // ลอง sqrt/fact ต่อท้าย (ถ้าเปิด)
          let astVariants = [ast];
          // sqrt
          if (operatorFlags['√'] && val >= 0 && MAX_SQRT_DEPTH > 0) {
            let sqrtVal = val, sqrtAst = ast, sqrtDepth = 0;
            while (sqrtDepth < MAX_SQRT_DEPTH) {
              sqrtVal = Math.sqrt(sqrtVal);
              if (isNaN(sqrtVal) || !isFinite(sqrtVal)) break;
              if (useIntegerMode && !isIntegerResult(sqrtVal)) break;
              sqrtAst = { type: "op", operator: "√", left: null, right: sqrtAst };
              astVariants.push(sqrtAst);
              sqrtDepth++;
            }
          }
          // fact
          if (operatorFlags['!'] && val >= 0 && val <= MAX_FACTORIAL_INPUT && Number.isInteger(val) && MAX_FACT_DEPTH > 0) {
            let factVal = val, factAst = ast, factDepth = 0;
            while (factDepth < MAX_FACT_DEPTH) {
              factVal = factorial(factVal);
              if (isNaN(factVal) || !isFinite(factVal)) break;
              factAst = { type: "op", operator: "!", left: null, right: factAst };
              astVariants.push(factAst);
              factDepth++;
            }
          }
          // ลูปทุก variant
          for (const astV of astVariants) {
            let valV = evaluateAST(astV);
            if (isNaN(valV) || !isFinite(valV)) continue;
            if (useIntegerMode && !isIntegerResult(valV)) continue;
            let nextNums2 = nextNums.concat([valV]);
            let nextExprs2 = nextExprs.concat([astV]);
            if (dfs(nextNums2, nextExprs2)) return true;
          }
        }
      }
    }
    return false;
  }

  dfs(nums, exprs);
  return found;
}

self.onmessage = function(e) {
  const data = e.data;
  operatorFlags = data.operatorFlags;
  useIntegerMode = data.useIntegerMode;
  MAX_SQRT_DEPTH = data.MAX_SQRT_DEPTH;
  MAX_FACT_DEPTH = data.MAX_FACT_DEPTH;
  MAX_FACTORIAL_INPUT = data.MAX_FACTORIAL_INPUT;
  MAX_RESULTS = data.MAX_RESULTS || Infinity;

  if (data.type === 'findFirstFast') {
    const { nums, target } = data;
    calculationCache.clear();
    // ใช้ DFS แบบ backtracking
    let closest = { value: null };
    let found = dfsFindClosest(nums, target, [], nums.map(n => ({ type: "num", value: n })), closest);
    if (found) {
      self.postMessage({ found: true, expression: found.expression, result: found.result });
      return;
    }
    // ถ้าไม่เจอเป๊ะ ส่งใกล้เคียงที่สุด
    if (closest.value) {
      self.postMessage({ found: false, closest: closest.value });
    } else {
      self.postMessage({ found: false, finished: true });
    }
    return;
  } else if (data.type === 'findAll') {
    const { chunk, target, nums } = data;
    let results = [];
    let expressionSet = new Set();
    let closestResult = null;
    let smallestDiff = Infinity;

    calculationCache.clear();
    expressionCache.clear();

    try {
      for (let p = 0; p < chunk.length; p++) {
        const perm = chunk[p];
        const expressions = generateAllGroupings(perm, target);
        if (!Array.isArray(expressions)) continue;
        for (let i = 0; i < expressions.length; i++) {
          const ast = expressions[i];
          const result = evaluateAST(ast);
          if (!isNaN(result)) {
            const diff = Math.abs(result - target);
            // เฉพาะ expression ที่ใช้เลขครบเท่านั้น
            if (usesAllNumbers(ast, nums)) {
              if (diff < smallestDiff) {
                smallestDiff = diff;
                closestResult = { 
                  expression: serializeAST(ast), 
                  result, 
                  diff, 
                  isExact: diff < 0.0001
                };
                self.postMessage({ progress: true, processed: p + 1, closest: closestResult });
              }
              if (diff < 0.0001) {
                const canonicalAST = canonicalizeAST(ast);
                const canonicalStr = serializeAST(canonicalAST);
                if (!expressionSet.has(canonicalStr)) {
                  expressionSet.add(canonicalStr);
                  results.push({ expression: canonicalStr, result });
                }
              }
            }
          }
          if (i % 100 === 0) {
            self.postMessage({ progress: true, processed: p + 1, closest: closestResult });
          }
        }
      }
      self.postMessage({ 
        results, 
        closest: closestResult 
          || null // ถ้าไม่มี expression ที่ใช้เลขครบ ให้ closestResult เป็น null
      });
    } catch (error) {
      self.postMessage({ 
        results, 
        closest: closestResult || null, 
        error: error.message 
      });
      return;
    }

    calculationCache.clear();
    expressionCache.clear();
  }
};