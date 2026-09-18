export const memo = (fn, areEqual) => ({
  $$typeof: Symbol.for('react.memo'),
  areEqual,
})
export const useMemo = (fn) => fn()
export const useCallback = (fn) => fn
export const useState = (init) => [init, () => {}]
export const useEffect = () => {}
export const useRef = (init) => ({ current: init })
export const createElement = (type, props, ...children) => ({ type, props, children })
export default { memo, useMemo, useCallback, useState, useEffect, useRef, createElement }