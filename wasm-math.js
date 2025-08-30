// WebAssembly Math Module - Fixed and optimized version
let wasmMathSingleton = null;

class WASMMathModule {
  constructor() {
    // Singleton pattern to prevent multiple instances
    if (wasmMathSingleton) {
      return wasmMathSingleton;
    }
    
    this.module = null;
    this.instance = null;
    this.isReady = false;
    this.errorMessage = '';
    this.initPromise = null;
    this.isInitializing = false;
    
    wasmMathSingleton = this;
    this.init();
  }

  async init() {
    // Prevent multiple initializations
    if (this.isInitializing || this.initPromise) {
      return this.initPromise;
    }
    
    this.isInitializing = true;
    this.initPromise = this.doInit();
    return this.initPromise;
  }

  async doInit() {
    try {
      // ตรวจสอบว่าเบราว์เซอร์รองรับ WebAssembly หรือไม่
      if (typeof WebAssembly === 'undefined') {
        throw new Error('เบราว์เซอร์นี้ไม่รองรับ WebAssembly');
      }

      // ใช้ WASM binary ที่มี add, sub, mul, div, sqrt - verified ใน Node.js
      const wasmBytesWithSqrt = new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 12, 2, 96, 2, 124, 124, 1, 124, 96, 1, 124, 1, 124, 3, 6, 5, 
        0, 0, 0, 0, 1, 7, 32, 5, 3, 97, 100, 100, 0, 0, 3, 115, 117, 98, 0, 1, 3, 109, 117, 108, 0, 2, 
        3, 100, 105, 118, 0, 3, 4, 115, 113, 114, 116, 0, 4, 10, 39, 5, 7, 0, 32, 0, 32, 1, 160, 11, 
        7, 0, 32, 0, 32, 1, 161, 11, 7, 0, 32, 0, 32, 1, 162, 11, 7, 0, 32, 0, 32, 1, 163, 11, 5, 0, 
        32, 0, 159, 11
      ]);

      // ลอง compile WebAssembly
      this.module = await WebAssembly.compile(wasmBytesWithSqrt);
      this.instance = await WebAssembly.instantiate(this.module);
      
      // ทดสอบฟังก์ชันทั้งหมด - 5 ฟังก์ชันใช้ WASM จริง!
      const tests = [
        { fn: 'add', a: 2, b: 3, expected: 5 },
        { fn: 'sub', a: 5, b: 2, expected: 3 },
        { fn: 'mul', a: 4, b: 5, expected: 20 },
        { fn: 'div', a: 10, b: 2, expected: 5 },
        { fn: 'sqrt', a: 25, expected: 5, isSingle: true }
      ];
      
      for (const test of tests) {
        const result = test.isSingle ? 
          this.instance.exports[test.fn](test.a) : 
          this.instance.exports[test.fn](test.a, test.b);
        if (Math.abs(result - test.expected) > 0.0001) {
          throw new Error(`WASM ${test.fn}: expected ${test.expected}, got ${result}`);
        }
      }
      
      this.isReady = true;
      return this.instance;
        
    } catch (error) {
      // ใช้ JavaScript fallback
      this.isReady = false;
      this.errorMessage = error.message;
      return null;
    } finally {
      this.isInitializing = false;
    }
  }

  add(a, b) {
    if (this.isReady && this.instance && this.instance.exports.add) {
      try {
        return this.instance.exports.add(a, b);
      } catch (e) {
        // Fallback to JavaScript
      }
    }
    return a + b;
  }

  sub(a, b) {
    if (this.isReady && this.instance && this.instance.exports.sub) {
      try {
        return this.instance.exports.sub(a, b);
      } catch (e) {
        // Fallback to JavaScript
      }
    }
    return a - b;
  }

  mul(a, b) {
    if (this.isReady && this.instance && this.instance.exports.mul) {
      try {
        return this.instance.exports.mul(a, b);
      } catch (e) {
        // Fallback to JavaScript
      }
    }
    return a * b;
  }

  div(a, b) {
    if (this.isReady && this.instance && this.instance.exports.div) {
      try {
        return this.instance.exports.div(a, b);
      } catch (e) {
        // Fallback to JavaScript
      }
    }
    return b !== 0 ? a / b : NaN;
  }

  pow(a, b) {
    return Math.pow(a, b);
  }

  sqrt(x) {
    if (this.isReady && this.instance && this.instance.exports.sqrt) {
      try {
        return this.instance.exports.sqrt(x);
      } catch (e) {
        // Fallback to JavaScript
      }
    }
    return Math.sqrt(x);
  }

  factorial(n) {
    if (n < 0 || n > 12 || !Number.isInteger(n)) return NaN;
    if (n === 0 || n === 1) return 1;
    let result = 1;
    for (let i = 2; i <= n; i++) result *= i;
    return result;
  }

  evaluateSimple(a, b, op) {
    switch (op) {
      case 0: return this.add(a, b);
      case 1: return this.sub(a, b);
      case 2: return this.mul(a, b);
      case 3: return this.div(a, b);
      case 4: return this.pow(a, b);
      default: return NaN;
    }
  }
}

// Global WASM module instance
if (typeof window !== 'undefined') {
  window.wasmMath = new WASMMathModule();
} else if (typeof self !== 'undefined') {
  self.wasmMath = new WASMMathModule();
}
