/**
 * Keeps `input[data-number]` to whole numbers inside its range in the browser,
 * without ever changing what was entered. A keystroke or paste that would leave
 * anything but digits in the field is blocked before it gets there, so the
 * previous value stays. Whatever still gets in (autofill, a browser without
 * `beforeinput`) is kept as typed and flagged with a custom validity message,
 * as is a value outside `data-min`..`data-max`, so the form will not submit.
 * Rewriting input would turn `-1` into `1` or `1e3` into `13`, which the server
 * could then no longer refuse. A leading minus is allowed only when
 * `data-min` is negative. Delegated, so rows added later behave the same.
 */
export const NUMBER_INPUT_SCRIPT =
  "(function(){" +
  "function bound(el,n){var v=el.getAttribute(n);return v===null?null:Number(v)}" +
  "function shape(el){var lo=bound(el,'data-min');return lo!==null&&lo<0?/^-?[0-9]*$/:/^[0-9]*$/}" +
  "function check(el){el.setCustomValidity('');var v=el.value;if(v===''||v==='-')return;" +
  "var lo=bound(el,'data-min'),hi=bound(el,'data-max');" +
  "var range='Enter a whole number from '+(lo===null?'any':lo)+' to '+(hi===null?'any':hi)+'.';" +
  "if(!shape(el).test(v)){el.setCustomValidity('Digits only. '+range);return}" +
  "var n=Number(v);" +
  "if((lo!==null&&n<lo)||(hi!==null&&n>hi))el.setCustomValidity(range)}" +
  "function target(e){var el=e.target;" +
  "return el&&el.matches&&el.matches('input[data-number]')?el:null}" +
  "document.addEventListener('beforeinput',function(e){var el=target(e);if(!el)return;" +
  "if(!e.inputType||e.inputType.indexOf('insert')!==0)return;" +
  "var text=e.data;" +
  "if((text===null||text===undefined)&&e.dataTransfer)text=e.dataTransfer.getData('text');" +
  "if(typeof text!=='string'||text==='')return;" +
  "var s=el.selectionStart||0,t=el.selectionEnd===null?s:el.selectionEnd;" +
  "if(!shape(el).test(el.value.slice(0,s)+text+el.value.slice(t)))e.preventDefault()});" +
  "document.addEventListener('input',function(e){var el=target(e);if(el)check(el)});" +
  "Array.prototype.forEach.call(document.querySelectorAll('input[data-number]'),check)" +
  "})();";
