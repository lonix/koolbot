/**
 * Keeps `input[data-number]` to digits and inside its range in the browser: it
 * strips anything else as it is typed or pasted, and sets a custom validity
 * message outside `data-min`..`data-max` so the form will not submit until it
 * is fixed. Delegated, so rows added later behave the same.
 */
export const NUMBER_INPUT_SCRIPT =
  "(function(){" +
  "function bound(el,n){var v=el.getAttribute(n);return v===null?null:Number(v)}" +
  "function check(el){el.setCustomValidity('');var v=el.value;if(v===''||v==='-')return;" +
  "var n=Number(v),lo=bound(el,'data-min'),hi=bound(el,'data-max');" +
  "if((lo!==null&&n<lo)||(hi!==null&&n>hi))" +
  "el.setCustomValidity('Enter a whole number from '+(lo===null?'any':lo)+' to '+(hi===null?'any':hi)+'.')}" +
  "document.addEventListener('input',function(e){var el=e.target;" +
  "if(!el||!el.matches||!el.matches('input[data-number]'))return;" +
  "var lo=bound(el,'data-min'),signed=lo!==null&&lo<0;" +
  "var clean=el.value.replace(signed?/(?!^-)[^0-9]/g:/[^0-9]/g,'');" +
  "if(clean!==el.value)el.value=clean;check(el)});" +
  "Array.prototype.forEach.call(document.querySelectorAll('input[data-number]'),check)" +
  "})();";
