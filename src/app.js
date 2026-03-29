/**
 * Pixel Terminal — app.js
 * Uses Tauri global APIs (withGlobalTauri: true), no bundler needed.
 *
 * Globals available:
 *   window.__TAURI__.shell.Command
 *   window.__TAURI__.dialog.open
 *   window.marked  (from marked.umd.js)
 */

'use strict';

// ── Tauri + marked globals ─────────────────────────────────

const { Command } = window.__TAURI__.shell;
const { open: openDialog } = window.__TAURI__.dialog;
const { invoke } = window.__TAURI__.core;
const { parse: mdParse } = window.marked;
window.marked.setOptions({ breaks: true, gfm: true });

// ── Sprite data (inlined — eliminates all load/protocol issues) ──────────
const SPRITE_DATA = {
  'cat': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAABTElEQVR4nGNgGAWjYBTgApxcIv/x8Qe7fooAJ5fI//stS/+DaBiG8YeCfpgZ+PggwMiAA4AUGzjYgNnPnzwH05IykgwXDhxh+P7tDU596PqR9YIAqfopsf9a1UQGrbZ8uBiMj6yfBZ8hIItBlsIcTw5A1gvzCLGAUvujjq1mQI4EEB8dMGHTCEsqIIvXlyvAHQNjE0qGMHmQepjlIDbMI8TqJ9d+GEBOObgCkQndYhBGTiIWucfBBu0PywOzQQBXEkTXD1IP0gfSD9NLin5y7SclAJmw5TmYJaD8Bgs5x1WTGF7euYvXcnT9IPUgfcTkX2raT0oAMmEzDGaguIoy3PEgDLKAlFIcpB85+ZGjn1z7iQ1AJnyGwDSDQpDUAmyg9RMbgEzoGmGKYJpJBYNJPzEByISeZJABSNMyq1Bw0gFhEBsXGOr6RwHDCAUAGpNqzZQe1mUAAAAASUVORK5CYII=',
  'rabbit': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAAA9klEQVR4nGNgGAWjYBQgA04ukf8gjItPKiBVP7XtJwSYsAmeW90AthgXn1RAqn5K7Cc1AJmIdRQpltMyxqgdgCz4DCI16YIsggGj0AaKA4EeAcmCLvD92xtGkOOX5DrDxa4dOkyUYUahiAAgRz+l9pMTgEz4JGMm70WhCTkchsnRT6n9yO4ARQQoAGEYXwAy4TMMlKSNeP3ANDlgoPUTE4CM+JIPLBmCDECOWWLAQOqH6dWys2XgOC/I8MPwPTh7YjODCV3g+tYp4FIcOQ+C2MQWSAOtHwRAKQYUaKCkf+7zJpyexwlAlsEcgsweKfpHwShgGDkAAJoz5Ga0OakEAAAAAElFTkSuQmCC',
  'penguin': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAAACXBIWXMAAAsTAAALEwEAmpwYAAABF0lEQVRYhWP8//8/w0gGTAwjHDAxjHDAxDDCARPDCAcsuCS4uEVRSsdvX18z0sVFVLSfKDP+//+PgTm5RP6rWsX9f/32JRyDxLCpxYVB6pExqXqpYT8xZjDg0gzTAKNJcQClHqDUflLMYMKXhB49vsrwfmYow8UaLVJTH8Oxzd0McrLaYDaMJhVQYj/RZvynYQyC8K02OzCmZwoixQwmbAWHjIEXRkCBxNALFXzAyrcUTAumrwZjYgGl9oPUqFnHg80ApUJ096ADJmyCTy5swynGyMiIFxPyACH9lNpPSD/BAPj+7Q3O6gafHCHLcDmA2vaTqp8Fl+KtPg/ghRcphRDIElBew6af2ACkxH5S9TOO9gYZRjYAADtGhP+ePrhdAAAAAElFTkSuQmCC',
  'crab': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAAA60lEQVR4nGNgGAWjYBSMgmEEOLlE/oMwseJMlBpAbUCJ/SD5OWoyOOVBcuhmsOAyIOUWw//v394w4hPH5QgQja4Glzi17ScVMGETTLn1hCgxdABzKHpI4xLHBci1H90t2NhEBcAcLMkIX9KitgcotZ8U/UzYBEGOffT4Kjzfgdj09ACl9lOkn5NL5P9SA4P/MBqZTUwhBFP3+u1LMI3MJtUMUu0nRz8TuuZjvhrg0ALRMIAsRsgRIHWg2JaT1QbTyGxCsUCp/eToZyHkGbAB6gjDCAGQJVabb8BpXGLEAHLsp6b+UTAKGIY/AADH7fC4BIq4LgAAAABJRU5ErkJggg==',
  'rat': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAABTElEQVR4nGNgGAWjYBSMZMCIS4KTS+Q/jP392xtGXGK0AJTaTYp+FnwGFdrpgun+Q5f/o/Fp7glK7CZFPyMhT2gLCaOIXX33lqjYB+lFtxSZT0wskms3KfqZiDFstrUoCk0MAFkE8uiuK88YQA4BYRCbGM9TajcpepmIMWj1R1YGNx0pMA2KReSkjAxKVSz+gzA5DqHUbmypD1kvLsCI7gEQ3X3nBCO2ZLR4Zi6DUWgDzhh0lDX8v//xeUaQOSAzYPpBjkAG2FIBpXZj039udQNDbPpk4rOQo6wh2BDkWAQZZCKj/r/Kw/E/odBHj32YXhi+vnUKTjMotRuXfpBekBm49DMhc0zY2RmwxQIsBkFsfA4B6QM5AOQYEA0KbVCog/SDML4YpNRuXPpBAGQGIf1wgOwBWAiCaGQ2A5GAVP2U2k1Nt4+CUcAwMgAAymMvotX5iBgAAAAASUVORK5CYII=',
  'seal': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAAAxklEQVR4nGNgGAWjYBSMghEMGAkp4OQS+Y/M//7tDUE91DSDUvsJ6WckpLmitwlFrKO4jmQPkGsGpfYTo5+JGINAmpBpcgAlZtBSLxNyaMGSCzIbBPYd3cGwY/MuMI0L4NNPjBm0sp8YvWAA0tA4fdp/ZBpZHFmMXP34zKCH/dj0M2LLM7B8AuL7ZSQzaKnKE5UHh6J+JnRDrt1+yAAyBJtmYsBQ08+ILgDTCAMFsaEMTtYeYDYoH4HY+Erhoa5/FIwChpEFAKM3JDuNyYkcAAAAAElFTkSuQmCC',
  'snake': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAABHUlEQVR4nGNgGOGAkWEYAk4ukf/I/O/f3jCOmADg5BL5X6iTznDs4zUGK34tMH3y8WGcgcCEyxBkTK5DyDWDUvv7r8wEex5G4wOMlIYgLg+Qawal9sP0wwDJ7ueEhnqVWTUKTZRmKphBTfuJ0c+ETRAWgrCYIAdQYgal9sNi+/72GPLcz0lCCNLCDGrZ/+JgAXkp4DulIUihGdSwHwYI6WciZAChUhQXAIU6yAOTSrlJLkSpYT+x+lmQOdiSCiwEkeVweWag9WMzB1k/Nn1MyJpAhQ4o1kAYPQTNZW3BhRKIxubQgdaPbg42/dj0MWILNRhAdggMgJI0qIGBHpoDrR+bOcj6celjxGYIPkeBACmNksGkn9xyaBQwDGMAAKNsPyaqyIfWAAAAAElFTkSuQmCC',
  'k-whale': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAACSElEQVR4nOVXzW7bMAymFCfNNuTYwvEpj6BnyMGAmlOeNKfAgA95BesNdhoK9DbksKaxrYGu6HKe/NOliQ8jQFAWRH4kJZmUsNbCv5IxRiilbN8alH3rro0PAN51wUBlJBxbBGTzEgCKLhtdDvYF8Jn4xhj4UAKMcw6l3mxLmk/2u4nebGvQpx/fRV8AbUEOSc418QFASE+muQEEK5P9borfxfkF4lgXKMmZvgBobIyRhOO+kSe3wnenhXBQvs3hP4BzlmXCsQyjlb2/D62bD+gbZZZlX7hOi50JruVMdonHxhf8J0g78ai1yIv3u/X8/FTtGABM41if0jT5CgAvvqPFdhOPbrVbaZpM9WZ7pp1Dmkzn1Q4qpcox8QOaiJZLYeX8zRk5h/z0s1788LC0qMCoE7wZgFIqT/a7md5sX9EJB/6NBz8GPgCUAQc//XoH5ZTnp4qRguAOBd7JV37PPhJAst9JHsAY+FQWA1TMCyi5wuFwqOR6vfY6BABnl1l7aQCPWsNY+AAgqn8AZogWtJFTxPv01+5VATD9rgDQTtPGGPh0AgQmwN0dTN+CFsaxrpXSNKHhTClVZZ/TJQEg3Rqfd4WiUQUkNRm84cBmw9dU8GalGcDxeKztLhaLzgBuiU/XpybbqKNUJ9145qvVbYy6KMNoRXVchNFK8vrerNWfjR9GqzuGj31AjeEYGIs/ToDLKnVX5dBHTKPrwiNeDn2seGxdit829uoK7LAcGC4c4mzzgVLXckfeANoccO+Rq+EPtAn/Lf0GFXRi02iJaN8AAAAASUVORK5CYII=',
  'cat2': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAAACXBIWXMAAAsTAAALEwEAmpwYAAABuElEQVRYhe1XsUoDQRDdW4JoAoKgQiy1EcFS/AAbGy0EfyB10N5axDZiq50/EBH8hWAnIjZiIyoqCNGcYrPy1rxlOfY2u4mFcj4YspOZt7NvmNtLEqWUKDKkKDikKDqUUrk2Uh5XPt9lNpDv83thUL4P5rzKI/5m+0jhk0Y/pAE+fqj4QfjcI8/neUu+DV4fdkWrVhVX6bDxY4D8/eVRvV6YqvTFR/2zu050fYi93GqIuZ1NI5r+e/qc8LuSb5Prl08xMzYkZssfol9AOEEhoUA++PYeP91A6SKWKxO6axA/ub5kDsM14y50H5821shncawppNcYM458V/3Qx4C1fU2UWeGwtPNkRuSk0dQbrew19Rqw4xnuWzeu5x754IFPLmCPYFY4zI676vfixzRQ2gIwLgRELh7em84db6yK+mnbKZ5o1aoVTgfykA8eD4P9fIe36yPPVT+EH9NAmScGQuwLDIYCvvF38e3xAz/mLeCqH8oPbaB0kZPkO4dkdNC+wBDPWgw/FIPwQxsos0QmkRyL38QPaqCyfsCAeF6f15fIwdq0tsfbC3OxcJ1X/C/xqTv5/zcoio0v6Sr8VDTnp8YAAAAASUVORK5CYII=',
  'frog2': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAAACXBIWXMAAAsTAAALEwEAmpwYAAABy0lEQVRYheWXvUvDUBTFbx5BTIpQIUFQcCidBNGtXVydqrg5O7hYcJMKzp06V3DyL9BBnBydKi6Cq5PgIK0iSNMuEjmvvfE1JmnSDx1yoLyP5Lzfvfe9Jq3mui6lWYJSLkEpl6CUS1DKJSjl0qMumhkbBfpS55x2U0OrabLxlPRtovrDvFH8qRfAzNjzRPS+Vyv45924QYyTADhop83XI/wy+frBNZVPS5TN974tTrvJwWnTSqB/j+SyEMfJzbZcL+4acfgizLxVyUmombFlC1U3r+R4mNjPBYRQQHyUAg5bQ3rh4TjAj6MkfBFkhtGybFlxGNBCPI4Dh0YpIPODuDyeJF9TH0AMb7V6SaIIqNr+2s6AaSVXoY7TGjiCWIfh8EHwAqoGzkGofo5B5eeLC7+4UO3iks6P7gKfJUn47Nf9i3Dy3N8tFuj55YGWl9a95GH2vwVYgP+sYdOtdTiQSH8HFgPNCv+p8UqVxhmVSwWPjTjCkh+Vr6nVXy07sj+b1em+OkMbxwZ9fL7RY92U83wdY/8JMEwrib/bcVqG//Qk4fuLkNDfddpNyfcKELajf6H//EcquGOYVuSPomEyTMvb0Rj3zo3DmqS+Aaa7NqYBW1vuAAAAAElFTkSuQmCC',
  'cat-120': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAABTElEQVR4nGNgGAWjYBTgAiKcXP/x8Qe7foqACCfX/6X3W/6DaBiG8YeCfpgZ+PggwMiAA4AU2xg4gNnPnz8B05KSMgxHLhxgePP9G0596PqR9YIAqfopsX/itSqGfK02uBiMj6yfBZ8hIItBlsIcTw5A1gvzCLGAUvtXRx1jQI4EEB8dMGHTCEsqIIsV1pfDHQNjE0qGMHmQepjlIDbMI8TqJ9d+GEBOObgCkQndYhBGTiLHLXLBBuXtDwOzQQBXEkTXD1IP0gfSD9NLin5y7SclAJmw5TmYJaD8Bgu5SY6rGO6+vIPXcnT9IPUgfcTkX2raT0oAMmEzDGagsrgK3PEgDLKAlFIcpB85+ZGjn1z7iQ1AJnyGwDSDQpDUAmyg9RMbgEzoGmGKYJpJBYNJPzEByISeZJABSFPoMitw0gFhEBsXGOr6RwHDCAUAG6ZqzVERfSsAAAAASUVORK5CYII=',
  'cat-195': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAABTElEQVR4nGNgGAWjYBTgAkIinP/x8Qe7foqAkAjn/5b7V/+DaBiG8YeCfpgZ+PggwMiAA4AU2xkagNnPXz0H05JikgyHzl9gePfmO0596PqR9YIAqfopsb/o9BmGPlMTuBiMj6yfBZ8hIItBlsIcTw5A1gvzCLGAUvvPpKUwIEcCiI8OmLBphCUVkMUKJuvhjoGxCSVDmDxIPcxyEBvmEWL1k2s/DCCnHFyByIRuMQgjJ5Hj2yzABvlu2ApmgwCuJIiuH6QepA+kH6aXFP3k2k9KADJhy3MwS0D5DRZymwO8GW4/fYnXcnT9IPUgfcTkX2raT0oAMmEzDGagqrQ43PEgDLKAlFIcpB85+ZGjn1z7iQ1AJnyGwDSDQpDUAmyg9RMbgEzoGmGKYJpJBYNJPzEByISeZJABSJPJrDngpAPCIDYuMNT1jwKGEQoArItuQnOG3owAAAAASUVORK5CYII=',
  'cat-270': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAABTElEQVR4nGNgGAWjYBTgApwifP/x8Qe7fooApwjf/4kt9/+DaBiG8YeCfpgZ+PggwMiAA4AUm9pog9lPnj8H0zKSkgynj1xl+P7mE0596PqR9YIAqfopsb+j4CJDxQR9uBiMj6yfBZ8hIItBlsIcTw5A1gvzCLGAUvvXnoliQI4EEB8dMGHTCEsqIItXKcyCOwbGJpQMYfIg9TDLQWyYR4jVT679MICccnAFIhO6xSCMnESsjvuCDcr33Q9mgwCuJIiuH6QepA+kH6aXFP3k2k9KADJhy3MwS0D5DRZyEzc7Mjy/+w6v5ej6QepB+ojJv9S0n5QAZMJmGMxASWUhuONBGGQBKaU4SD9y8iNHP7n2ExuATPgMgWkGhSCpBdhA6yc2AJnQNcIUwTSTCgaTfmICkAk9ySADkKZgk2XgpAPCIDYuMNT1jwKGEQoAc35qobXmWTAAAAAASUVORK5CYII=',
  'rabbit-120': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAAA9klEQVR4nGNgGAWjYBQgAxFOrv8gjItPKiBVP7XtJwSYsAk2nFsNthgXn1RAqn5K7Cc1AJmIdRQpltMyxqgdgCz4DCI16YIsgltqFEpxINAjIFnQBd58/8YIcrzzkly42OFrh4gyrMEoFM4mRz+l9pMTgEz4JPfGTEahCTkchsnRT6n9yO4ARQQoAGEYXwAy4TMMlKT9jHjBNDlgoPUTE4CM+JIPLBmCDECOWWLAQOqH6bXVsmMQ5DjP8P6HITh7YjODCV1gyvWt4FIcOQ+C2MQWSAOtHwRAKQYUaKCkv+ncZ5yexwlAlsEcgsweKfpHwShgGDkAAJPs5GaMWlQ5AAAAAElFTkSuQmCC',
  'rabbit-195': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAAA9klEQVR4nGNgGAWjYBQgAyERzv8gjItPKiBVP7XtJwSYsAk2TTwHthgXn1RAqn5K7Cc1AJmIdRQpltMyxqgdgCz4DCI16YIsgoG6fCOKA4EeAcmCLvDuzXdGkONdk5fAxQ5fukaUYXX5RnA2OfoptZ+cAGTCJ7l7bgwKTcjhMEyOfkrtR3YHKCJAAQjD+AKQCZ9hoCStm6EBpskBA62fmABkxJd8YMkQZAByzBIDBlI/TK+tnhbDB6t/DALHmMDZE5sZTOgCU5ZeB5fiyHkQxCa2QBpo/SAASjGgQAMl/cszbuD0PE4AsgzmEGT2SNE/CkYBw8gBANBC5M61sPnCAAAAAElFTkSuQmCC',
  'rabbit-270': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAAA9klEQVR4nGNgGAWjYBQgA04Rvv8gjItPKiBVP7XtJwSYsAmebTgJthgXn1RAqn5K7Cc1AJmIdRQpltMyxqgdgCz4DCI16YIsggHjBnOKA4EeAcmCLvD9zSdGkONnOs+Hi505fI0ow4wbzOFscvRTaj85AciETzJ9byIKTcjhMEyOfkrtR3YHKCJAAQjD+AKQCZ9hoCT9XtcITJMDBlo/MQHIiC/5wJIhyADkmCUGDKR+mF4TWy2G3R84GFwFfoCzJzYzmNAFrk25Di7FkfMgiE1sgTTQ+kEAlGJAgQZK+oKXz+H0PE4AsgzmEGT2SNE/CkYBw8gBAJhD6auViNGwAAAAAElFTkSuQmCC',
  'penguin-120': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAABF0lEQVR4nGP8//8/w0gGTAwjHDAxjHDAxDDCARPDCAcsuCREubhRSsfX374y0sVFVLSfKDP+//+PgUU4uf7HqVr9f/n6LRyDxLCpxYVB6pExqXqpYT8xZjDg0gzTAKNJcQClHqDUflLMYMKXhK4+eswQ+n4mg9bFGlJTH0P3sc0M2nKyYDaMJhVQYj/RZvynYQyCsN2tNjCmZwoixQwmbAWHl4wBRkCBxNALFXyg1MoXTK8WTAdjYgGl9oPUxKtZg80ApUJ096ADJmyC255cwCnGyMiIFxPyACH9lNpPSD/BAHjz/RvO6gafHCHLcDmA2vaTqp8Fl+IHW33ghRcphRDIElBew6af2ACkxH5S9TOO9gYZRjYAADmwhP+A5DVvAAAAAElFTkSuQmCC',
  'penguin-195': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAABFklEQVR4nGP8//8/w0gGTAwjHDAxjHDAxDDCARPDCAcsuCSERblQSse3r78x0sVFVLSfKDP+//+PgYVEOP/Hhav+f/PyLRyDxLCpxYVB6pExqXqpYT8xZjDg0gzTAKNJcQClHqDUflLMYMKXhG5dfcIQ1PSWQSf8Iqmpj6Fv0gkGNW0ZMBtGkwoosZ9oM/7TMAZB2C77FhjTMwWRYgYTtoLDxxkzxkBi6IUKPlCUZwGm19UJgzGxgFL7QWriI9TAZoBSIbp70AETNsEte5/gFGNkZMSLCXmAkH5K7Sekn2AAvHvzHWd1g0+OkGW4HEBt+0nVz4JL8QORrfDCi5RCCGQJKK9h009sAFJiP6n6GUd7gwwjGwAAvwyE3cAQBREAAAAASUVORK5CYII=',
  'penguin-270': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAABDElEQVR4nGP8//8/w0gGTAwjHDAxjHDAxDDCARPDCAcsuCS4RPlRSsdvrz8y0sVFVLSfGDNYcGmU8ZJjONG9F0WMFEdQ4gFq2U+UGf///8fAnCJ8/9++fPkfmQZhbGpx6VeN0wHrhWFS9VNiPylmMOELxSdXbzM8D/3IcFrrDAOpABTyMtqqYDaMJhVQYj+xZjDh0mhR6gymJVfzgzEtLMcHqGE/MWYw4co76AAkhp6vKbUcG6DUfpAatXhdjPwPcw9RKeDJtkc4xRgZGfFiQh4gpJ9S+wnpJxgA3998wlnS4pMjZBkuB1DbfpL1/0crFUEAVFpesbsFLzlhbKJ8MMj1o/uXcbQ3yDCyAQCHwXd3LP7YigAAAABJRU5ErkJggg==',
  'crab-120': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAAA6UlEQVR4nGNgGAWjYBSMgmEERDi5/oMwseJMlBpAbUCJ/SB5mTlqOOVBcuhmsOA0IOXW/zffvzHiE8flCBCNrgaXOLXtJxUwYRN8knKLKDF0AHMoekjjEscFyLUf3S3Y2EQFgAyWZIQvaVHbA5TaT4p+JmyCIMdeffQYnu9AbHp6gFL7KdIvwsn132CpwX8YjcwmphCCqXv5+i2YRmaTagap9pOjnwlds8YxX3BogWgYQBYj5AiQOlBsa8vJgmlkNqFYoNR+cvSzEPIMxAB1BmIByJIbVpvhNC4xYgA59lNT/ygYBQzDHwAAtcDwuIge+z4AAAAASUVORK5CYII=',
  'crab-195': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAAA5klEQVR4nGNgGAWjYBSMgmEEhEQ4/4MwseJMlBpAbUCJ/SB5uZI5OOVBcuhmsOA0oCfl/7s33xnxieNyBIhGV4NLnNr2kwqYsAk+6kkhSgwdwByKHtK4xHEBcu1Hdws2NlEBIIclGeFLWtT2AKX2k6KfCZsgyLG3rj6B5zsQm54eoNR+ivQLiXD+N+hY+h9GI7OJKYRg6t68fAumkdmkmkGq/eToZ0LXrFV9DBxaIBoGkMUIOQKkDhTbatoyYBqZTSgWKLWfHP0shDwDM4BYAFJ7rdUKTuMSIwaQYz819Y+CUcAw/AEAonX4uMskwnsAAAAASUVORK5CYII=',
  'crab-270': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAAA6ElEQVR4nGNgGAWjYBSMgmEEOEX4/oMwseJMlBpAbUCJ/SD5RJnpOOVBcuhmsOAyYD5D5v/vbz4x4hPH5QgQja4Glzi17ScVMGETnP8kkygxdABzKHpI4xLHBci1H90t2NhEBUAilmSEL2lR2wOU2k+KfiZsgiDHPrl6G57vQGx6eoBS+ynSzynC9z/LYOl/GI3MJqYQgql7+/IlmEZmk2oGqfZTrJ9ThO//Apvz/2E0zABkMXyGwDyMzwGE9FNqP6n6WfAFCCzZmGkcZCAWTNc4yJB5wx5O4xIjBpBjPzX1j4JRwDD8AQC3bxS95pSsyQAAAABJRU5ErkJggg==',
  'rat-120': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAABTElEQVR4nGNgGAWjYBSMZMCIS0KEk+s/jP3m+zdGXGK0AJTaTYp+FnwG6RbagenL/Yf+o/Fp7glK7CZFPyMhTwhrC6GIvb36jqjYB+lFtxSZT0wskms3KfqZiDFMdLY1Ck0MAFkE8uizXVcYQA4BYRCbGM9TajcpepmIMYh19UcGKTcdMA2KReSkjAwsSlX+gzA5DqHUbmypD1kvLsCI7gEQfaL7DiO2ZJS7eCZDg1Eozhg0dJT9f37/Y0aQOSAzYPpBjkAG2FIBpXZj099wbjXD5Nh04rOQoaMs2BDkWAQZpG4i89+xyuM/odBHj32YXhiecn0rTjMotRuXfpBekBm49DMhc9hN2BmwxQIsBkFsfA4B6QM5AOQYEA0KbVCog/SDML4YpNRuXPpBAGQGIf1wgOwBWAiCaGQ2A5GAVP2U2k1Nt4+CUcAwMgAAttIvormOJcIAAAAASUVORK5CYII=',
  'rat-195': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAABTElEQVR4nGNgGAWjYBSMZMCIS0JIhPM/jP3uzXdGXGK0AJTaTYp+FnwG6QcWgumL6/v/o/Fp7glK7CZFPyMhT3ApqKGIfXtwi6jYB+lFtxSZT0wskms3KfqZiDFMIXoBCk0MAFkE8ujt81sZQA4BYRCbGM9TajcpepmIMYj12moGVUNvMA2KReSkjAxUSkv/gzA5DqHUbmypD1kvLsCI7gEQfae7mxFbMqooXMFQl2+EMwZlHc3+P95/ihFkDsgMmH6QI5ABtlRAqd3Y9DdNPMfQ0R9BfBaSdTQDG4IciyCDZEz0/zumVv0nFProsQ/TC8NTll7HaQalduPSD9ILMgOXfiZkDruJPQO2WIDFIIiNzyEgfSAHgBwDokGhDQp1kH4QxheDlNqNSz8IgMwgpB8OkD0AC0EQjcxmIBKQqp9Su6np9lEwChhGBgAAmwc2n4aNC6AAAAAASUVORK5CYII=',
  'rat-270': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAABTElEQVR4nGNgGAWjYBSMZMCIS4JThO8/jP39zSdGXGK0AJTaTYp+FnwGRevmgOmll6f8R+PT3BOU2E2KfkZCnhDhUEMRe/PjFlGxD9KLbikyn5hYJNduUvQzEWNYs8JsFJoYALII5NGdt3cxgBwCwiA2MZ6n1G5S9DIRY9AR1tUM7qpuYBoUi8hJGRlYqpT+B2FyHEKp3dhSH7JeXIAR3QMg+vidbkZsyWhnxWIG4wZznDEoK+/4//HD/Ywgc0BmwPSDHIEMsKUCSu3Gpv9sw0kG945Y4rOQrLwj2BDkWAQZJCtj8j/Fseo/odBHj32YXhi+NuU6TjMotRuXfpBekBm49DMhc2RYTRiwxQIsBkFsfA4B6QM5AOQYEA0KbVCog/SDML4YpNRuXPpBAGQGIf1wgOwBWAiCaGQ2A5GAVP2U2k1Nt4+CUcAwMgAAW+cy+ya8mEwAAAAASUVORK5CYII=',
  'seal-120': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAAAxklEQVR4nGNgGAWjYBSMghEMGAkpEOHk+o/Mf/P9G0E91DSDUvsJ6WckpLmpohdFrK6jmGQPkGsGpfYTo5+JGINAmpBpcgAlZtBSLxNyaMGSCzIbBHbsO8qwa8dmMI0L4NNPjBm0sp8YvWAA0jCtcfp/ZBpZHFmMXP34zKCH/dj0M2LLM7B8AuIn+2UwyGupEpUHh6J+JnRDHl67zQAyBJtmYsBQ08+ILgDTCAOhBbEMHk7WYDYoH4HY+Erhoa5/FIwChpEFAKejJDuFqsD+AAAAAElFTkSuQmCC',
  'seal-195': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAAA20lEQVR4nGNgGAWjYBSMghEMGAkpEBLh/I/Mf/fmO0E91DSDUvsJ6WckpLm1sAJFrLq/g2QPkGsGpfYTo5+JGINAmpBpcgAlZtBSLxNyaMGSCzIbBPZu3s+w88AOMI0L4NNPjBm0sp+QXiZkDii5ICcbUFIBhdyJfTsZ3B08GJx9HfEmP3T9yIAYM6htP0gtSA9IL8gMbNmHET0UQZphCkH81AA/BgVFLaLy4FDUz4RuyIP71+Ahia6ZGDDU9DOiC8A0wkBEciE46YEAKB8RSoZDXf8oGAUMIwsAAD3nGFwZhYIdAAAAAElFTkSuQmCC',
  'seal-270': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAAAxklEQVR4nGNgGAWjYBSMghEMGAkp4BTh+4/M//7mE0E91DSDUvsJ6WckpLmluRhFrKa2l2QPkGsGpfYTo5+JGINAmpBpcgAlZtBSLxNyaMGSCzIbBI7u3smwcecOMI0L4NNPjBm0sp8YvWAA0tA7vfE/Mo0sjixGrn58ZtDDfmz6GbHlGVg+AfEjkz0ZtBW0iMqDQ1E/E7ohVx9cYwAZgk0zMWCo6WdEF4BphIGciAIGa1d3MBuUj0BsfKXwUNc/CkYBw8gCADuuJArhXNfLAAAAAElFTkSuQmCC',
  'snake-120': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAABHUlEQVR4nGNgGOGAkWEYAhFOrv/I/DffvzGOmAAQ4eT6n16ow3Dt2EcGLSt+MH345GOcgcCEyxBkTK5DyDWDUvtn9l8Bex5G4wOMlIYgLg+Qawal9sP0wwDJ7heBhnp1lRkKTZRmKphBTfuJ0c+ETRAWgrCYIAdQYgal9sNiO+b+dvLcL0JCCNLCDGrZX/DiIHkp4A2lIUihGdSwHwYI6WciZAChUhQXAIU6yAPck0pJLkSpYT+x+lmQOdiSCiwEkeVweWag9WMzB1k/Nn1MyJpAhQ4o1kAYPQRtzWXBhRKIxubQgdaPbg42/dj0MWILNRhAdggMgJI0qIGBHpoDrR+bOcj6celjxGYIPkeBACmNksGkn9xyaBQwDGMAAJoiPyZKERylAAAAAElFTkSuQmCC',
  'snake-195': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAABH0lEQVR4nO2VSwrCMBCGpyEL3YpL0Y0r79CruBPP1PMEPIKrglhcilvdVSYQGMtMWjOVSvWHEEL5/nk0D4AfVwYj1Gw+ren6dr2LdVoYYfHrfQ6P4xkmm5WfwVW11AQjmdCRmkiqhzZ+WThffJhjstoOSgWkevQRH/kwez4io+2gJI2HhsVGIRdGG2+0HZSk8dDGD7tluzu18paDy8LVL8m46u0EUj36iE/ld0CEN1ISXTsoSePRR/ygpDuAKvUOwMsMCziYLVxcFX2LPxG/K2/pgntyQgfpN6mYoXnOh/IcZyiE5w3/Go5mBxf50p9HnLlEh+abPhzPcRnXtSCaSBBuaXxemt0cmud8KC9xGWcSSwrV9Tx/G596D/0FI9YTHd8rVnfpxhQAAAAASUVORK5CYII=',
  'snake-270': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAABJ0lEQVR4nGNgGOGAkWEYAk4Rvv/I/O9vPjGOmADgFOH7r+uay/DxyzUGfh4tMP3o+F6cgcCEyxBkTK5DyDWDUvsv754M9jyMxgdYiAzB//iSETXNoIb9IP0wGqQfH2CiNARxAUrMoEQvKKBA+mCYkH4mSkMQF6DEDErth6WW+zFHCepnwab58u7J/1Eds5dkB5BrBjXsRwaQFLCXtBTwnYQQxAUoMYMa9sMAWWUAMiC3DAAVZiAP+L1cgbcaopX9xOpnQeZgq3JgIYgsh8szA60fmznI+rHpY0LWBMpvoFgDYfQQlLN0BudHEI3NoQOtH90cbPqx6WPEFmowgOwQGAAlaVD1gh6aA60fmznI+nHpY8RmCD5HgQCx+Xmw6Se3HBoFDMMYAADJwTPFlN4yQgAAAABJRU5ErkJggg==',
  'k-whale-120': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAACSElEQVR4nOVXzW7bMAymHCfNNuTYwvEpj6BnyMGAmlOeNKfAgA95BesNdhoK9BbksKW1rYGa6HGu/NM2iQ8jQEgWRH6kSIm0MMbAR0lrLaSUpm8Pjn37ro0PAN594UBhJJwbBGTrAQCUXTq6DOxz4JL4Wmt41wFoZxyOW7WpaH2X7idbtalBvz/9EH0OtDk55HCuiQ8AIvCcNFeAYNUu3U/x+1f5CipJShzJmD4HaK61DgjHfSNPboXvsoVwcPyzhm8A5zzPheNgFcUmur83bj2kbxzzPP/CZVr0THAvZ9JLPDa+4I8gRUI9KgFFWafZ0/OzjRgATFWSnNMs+4oB8aUWiyamro1WmmXTrdq8UuSQ5pOpjaCUshoTP6SFZbwUcxNYY+YQwLE415uXDw8GBRh1gjcdkFIWu3Q/26rNCxrhwL9x58fAB4Aq5ODH80/w0bkoLCPdhVYErXnh9+w9DuzSfcAdGAOfymKIglCUFRc4HA52XK/XXoMAwOZSE/wjDqhHBWPhA4CwbwCeEG1oIyeI9+lN9NABLt/lAOp5o2MEfMoAgQfg7s4RABa0USVJLZRmGU1nUsq/L8kFHEC6NT7vCkWjCgTUZPCGA5sNX1PBm5WmA6fTqda7WCw6HbglPl2fmkyjjlKddPOZr1a3McriuIpiquNiFcUBr+/NWn1p/FUU3zF87ANqDMfAWPyTAe5Uqbuqhv7ENLouTPFq6M+KR9dn8dvmXlmBHZYDw41DjG3+oNS13JHXgTYD3P/I1fAH6oT/ln4D/v1i03+XSFUAAAAASUVORK5CYII=',
  'k-whale-195': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAACRUlEQVR4nOVXvY7bMAymHOfnWmRs67vJj6BnyBDE2fykHh1kyCtYb3DjFd2MDL3kHKugKgqsK/9cc4mHEiAkCyQ/kvohLbTW8K+klBJSSt0ng2Of3K3xAcArFw5URsK5RkC2HgDApctGl4N9AXwkvlIK3pUAZZ3DMU2TmtazLJ+kaeJAn59fRF8AbUEOSc4t8QFABJ5McwMIVmdZPsXvn68X2CTrC47kTF8ANFdKBYRjv5En98K3p4VwcPy9hm8A56IohOUgjiP9Lfqi7XpI3zgWRfHAdVrsTFCWM9klHhtf8EeQdiLZboXWlTtm319+mB0DgOkmWZ92+f4TALz6jhbbTTy6Zrd2+X6apskb7RzSw2JidlBKWY+JH9LC49OTWMy1cWYxByjLyglHj181KjDqBG8GIKWssiyfpWlyRics+Gce/Bj4AFCHHLwsT+Cj86kyjDSbGxW8k2d+z94TQJblAQ9gDHwqiyEqal3VXOFwOJhxtVp5HQKAN5tZfW0AyXYLY+EDgDBvAGaIBNrIKuJ9+mv3MACu3xUA2mnaGAOfToDABNi7UwLAkgQ3ydop7fK905dSmuxzuiYApHvj865QNKpAQE0Gbziw2fA1FbxZaQZwPB6d3eVy2RnAPfHp+jjSjTpKddLOZ75a3caoi2McR1THRRxHAa/vzVr90fhxHM0ZPvYBDsMyMBZ/nACbVXou66E/MY2uC494PfRnxWPrWvy2uVdXYIdlwVBwiLPNHxRXyy15A2hzwP6P3Ax/oE34b+kXPEJreccaH2oAAAAASUVORK5CYII=',
  'k-whale-270': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAACR0lEQVR4nOVXzW7iMBD+HAJlu+K4bciJR/AzcAC5nHhSTiiCA68Qv0FPVdW9IQ4thSSrST2RN3VI+gM5dKSJHWtmvhn/zVhkWYbPktZaSCmzOhlq6+TOjQ/AKec3VCaifkaA1rgHIDll45SDdQF8J77WGh+aAG2co1bNZymPR4tlR81nBejj/YOoC6AqyCaTc058AMJzzLRtgMDSaLHs0n/ycsRETRNq2Zm6ALivtfYYx/wTdy6Fb3YL41D7NkZ3gM1xHAvDXjAKsz/BTWbGff6nNo7jX7ZOhZ0OydrMdpnbxhf2JcgrodSdSJAU2+zv41O+YgC6EzXdr6PVNYAX19ayVpO2br5a62jVVfPZgVeOqNP38xWUUqZt4vs8MByGAn3x5kxf4Lg9FMI3w9uMFCw6CV4OQEp5jBbLnprPXskJA/7bDr4NfACpb4Pvt89w0XF/yJnIv8qPI31e7XP2kQCixdKzA2gDn9OiT4oJktRW2Gw2eTsej50OAciFy+CfCUCpO7SFD0DkdwDNEAtUkVGk8/Ru9fIA9s0CIDtlG23g8w4QNAHm7GwBDFhwoqaF0jpacbcnpXzn6VcCILo0vl0VilIW8LjIsAsOKjZcRYVdrJQD2O12hd3BYHAygEvi8/EpKCvlUc6Tpt9z5eoqJl1qg1HIeVwEo9Cz83s5V383fjAKryx8qgMKDMOwWPy3A8yscnWVNn3ElKou2uJp08eKw9ZX8av6Tl1BFZYBI8EmzpYfKEUuN+QMoMoB8x45G35Dm/ix9A/aRVrl6rSvcQAAAABJRU5ErkJggg==',
  'cat2-120': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAABuElEQVR4nO1XsUpDMRTNC0W0hYKgQh11EcFR/AAXFx0Ef6Bz0d1ZxLXiqps/UBH8heImIi7iIioqCK2t4hI5sSeER16atA7K88Club335OZc7strE6WUyDOkyDmkyDuUUpk2MVZUPt9lNpDv8/thWL4P5rzKI/74dkfhk0Y/pAE+fqj4YfjcI8vneQu+Dfbaj6LSrIrR667xY4D88sGKXpcWpwfio37n/D66PsTWr7bF1vyuEU3/5b2b8LuCb5PPm1cxMjsuPuaKYlBAOEEhoUA++PYeP91A6SJOFku6axC/PLVhDsM14y70Hp8W1shncawppN8YM458V/3Qx4C1fU2UaeGw527HjEjjtK43aqzu6zVgx1Pct168TC54mt/jAvYIpoXD7Lirfj9+TAOlLQDjQkDkw9KR6dzayaZo1c6c4olKs1ridCAP+eDxMNjPd3i7PvJc9UP4MQ2UWWIgxL7AYCjgG38X3x4/8GPeAq76ofzQBkoXOUm+c0hGB+0LDPG0xfBDMQw/tIEyTWQSybH4TfygBirrBwyICxc1fYnMHK5ru3y6MxcL11nF/xKfupP/f4Mi3/gCz0T8VCgxpfMAAAAASUVORK5CYII=',
  'cat2-195': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAAByklEQVR4nOVWPUsDQRDdW0Q0Ab9ibGKljY2dQbC1NmV+hFhZWouNYGXrD9Ay4l8QQqwkARux0caPKKJRBFl5y80xHLt7u14R5R4st5Odt7NvMrN3kVJKFBlSFBxSFB1KKeuYmR1XLts0OODvsrOQl+9Ccl7lEL9701N40iDbJwEuvq/4PHzaw2bTeSPbJVipllSt2dbzscGVfn6WlsTdyap4ehhEtqBRFCXBwH+/7Wi7PF/XT/D7jx9WPj8sxed7hPC3OxfioL6S/EY2+KR7xLXJ1/O1GJ1e1MJ/CxLOhfgC/uDzPUJwvP8t+J8A2+sSrFRLOj0Qvz45lxyG5rRuQtw+r5jDn4JjTkKyypjW4W+K79sGvHJsSZRp4Ri8xFu9M71Ra29DzwFTC8Tct3h9grjgaX7MBWwlTL3O103xs/ghCZRcAPUciUS/UeYaO6fi5XzL2f+1ZrtM1QE/+IPn07+850mkKb4PPySB0iYGQqbWDpPDYyCAq/xNfF5+4Ie8BUzxffm+CZSum5zIyCC/wLCeHiF8X+Th+yZQponkRORQ/CW+VwIV+4ABcXnzUl8iC40jPbrd++Riobkt+H/iZ34IFQVy2AcYNn4ATvoJHwPkVVIAAAAASUVORK5CYII=',
  'cat2-270': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAABwUlEQVR4nO1XPUsDQRCdW4KogbPRIpVEGxGilZ2djSD4A/wV2mkvaGf8AbZi2kDAyiqVVgYLGwkWIqhNEr+wWXmbm2U59vb2chbK+WDITnbezL5hbi8JpJRUZAgqOAQVHVLKRJuYDqXLt5kJxLv8NOTlu6DPKx3ij/e7Ep9s7Ps0wMX3FZ+HzzmSfD5vyZWg1hhQq9Km7vit8quNgW9tzT8Ij9R6qbxCNAIf9TtvV9r3BcQebl/Tbn1Zi2b/46Uf8HclV5L7rzuaHZun6ucCjQolPAIL8QXiwTdz/HQDhY04OTOlugbxi2vDZiEJr3nfhujx6WONeC6ONQtJG2PeR7ytvu9jwLVdTRRx4bD3554ekbPmpUq01VxXa8Dcj3Ffo/2QueCBz1zAHMG4cJi5b6ufxs/SQGEKwLgwIHLjcVV37nTznPb6O1bxjFalXebpQBziwePDIJ/r8GZ9xNnq+/CzNFAkiYEQ8wKDoYBr/G18c/zAz/IWsNX35fs2UNjIQTCMYTI6aF5g2I9bFr4v8vB9GyjiRA5iclb8Jr5XA6XxAwbEi1pHXSL1uRNlTzcP+mLhdVLxv8Rn3cH/v0EqNr4BHwX/OTKRLAIAAAAASUVORK5CYII=',
  'frog2-120': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAAByUlEQVR4nOWXv0vDQBTHX44gJkWocEVQcCidBNGtXVydqnRzdnCx4CYVnDt1ruDkX6CDODk6VVwEVyfBQRpFkKZdJPKefec1JmnSHzrkC+V+JN/7vPfuSFLD8zxIswSkXAJSLgEpl4CUS0DKZUZdzNkZLNCnPtd2Owa2hkGNUtK3ie4P80bxp16AnJ2ZB4C34m7DP+/FDWKcBJCD7bT5ZoSfkr9q7kO5egIiW+AFODhjWgn07yEuC+PYPr6m9eKuEYcvwsz5rRpBc3aGWtRlfZPGw8R+LiCBsgX6aQUctgZ50cNxID+OkvBFkJmqLCVVHA3YongcB44apYDMD+LyeJJ8Q38AKbjjfI+lpKpV9tYGTLWVPDhdd+AI4joMRx8KvQjVA+cgdD/HoPMXCqVfXNRF4xxuzw4DnyVJ+Ow3/Ytw8twv7pTg/ukZ1peXVPJo9r8FVBBS/hQQAA5u5EAi/R1YDDRr/JfHFpzWWlCslhUb4whLflS+oVffXa1S35zNwsxdHayNI3h9/wD7oUnzfB3H/hMgLTuJv+d0Xct/epLw/UVI6O+13Q7xVQHCdvQv9J//SAV3pGVHfhQNk7RstaMx7p0bhzVJfQGbQzamtWeNQgAAAABJRU5ErkJggg==',
  'frog2-195': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAABvUlEQVR4nOWXv0vDQBTHX44gJiBqmiyKguLQTbf6FzgVESfdxFHESazuLoqTiOCiq1MHcepfUAehY4dOQoeaH4NC2kUi75oXYsxPmuqQ73L3Lvfu8943kGsFx3GgyGJQcDEouBgUXAwKLgYFlxj3sKTJaNCXf83UbQFHQeCDp6y3iT8/KjeOP3YDSpo8CwBWrXIVXHfSFjFKA8jBcdx8MSafN3/yfACX1VtYZCt0ABUnjKsBdw/nkrCOx80GPy/tGWn4YlTy/vIph5Y0mTeN8J2nDR4nifI1TR3FwF/coSmdXPhkAgtLRtcwGeFUBIriNHAUGYgjKo2BxA/jUpwnXwyD67oxXNAQDqBsrXp7Gve9RDiaF1Y4xVEm+Pm4N8jF+K3eyZUvBg/xmnfnk5V1eG91obw2z9d2a0v8QxK8BUgI9xt4faRC2deIC5+LaoJyX3tNgLsmLFSqHrvd6sLFy3HshzQrX6ArCN3btg/5fFqcgYeJc9iTzuDD/IS6fMPX6TnGltH/UYSiSlnyB5bRlygXa8jKD5qQMX9g6jbnewZEvdG/0H/+I2U0UVQp9kdRkhRV8t5oir1To7Dy1Dchjz5NXA84nwAAAABJRU5ErkJggg==',
  'frog2-270': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAABzUlEQVR4nOWXPUvDUBSGz71EIQUblaSCnQRBnZROXbrqUhxEcOg/EHUSVHB0dFHE0d1BB+nk2qWjW39BB00rtEJaUImc255wG/PZDx3yQrm5Sd77nPMmTVpm2zYkWRwSLg4JF4eEi0PCxSHhUoIOpgwNA/qW91lmi+HImBgcxX2byH4/bxB/4gGkDG0OAN4vCwX3fjtqEaM0gBwcJ81XAvyi+f3HMtzuFGF5qvdtscwWFccm1UD/HMElYR3Pe9tivahrROFzP/PpyqqApgxNjKjN+ycxDxP5KUAUBogfKcCwNYQXPVQH8qMoDp97mdGoZwyROBpwRNE8Chw1TIDE9+LSfJx8Jj+ACN54M8UcQ8DU1rcOB0xLJ7vQabQHbkFch+DoQ6EXoXLhVITspxpkfj678IuLeihfwXGl4vksicMnv+JehJqn7XyuBPWXGmQ31pzm0ex+C5AQ7qyRMUA/uh5opH8FFj3NEr9af4Xq3TkUcyWHjXX4NT8sn8npH9hfYnt2WoGLT4CzeQ0+mk24Yb2c6DjO3XeAqqfj+LudRlt13z1x+O4QYvq7ltkSfCcAvyv6F/rPf6ScNlQ9HfijKEyqnnauaIRzZ0ZhjVM/00Y1hr1+fYAAAAAASUVORK5CYII='
};

// ── SpriteRenderer ─────────────────────────────────────────
// CSS background-image + RAF. No canvas. No image load events.
// Sheet 64x16 displayed at 128x32 (2x). backgroundPosition shifts per frame.

const ANIMALS = ['cat', 'rabbit', 'penguin', 'crab', 'rat', 'seal', 'snake', 'k-whale', 'cat2', 'frog2', 'cat-120', 'rabbit-120', 'penguin-120', 'crab-120', 'rat-120', 'seal-120', 'snake-120', 'k-whale-120', 'cat2-120', 'frog2-120', 'cat-195', 'rabbit-195', 'penguin-195', 'crab-195', 'rat-195', 'seal-195', 'snake-195', 'k-whale-195', 'cat2-195', 'frog2-195', 'cat-270', 'rabbit-270', 'penguin-270', 'crab-270', 'rat-270', 'seal-270', 'snake-270', 'k-whale-270', 'cat2-270', 'frog2-270'];
const IDENTITY_SEQ_KEY = 'pixel-terminal-identity-seq-v7';

function getNextIdentity() {
  // Cycles through all 9 animals in order before repeating.
  // No hue rotation — sprites use their original pixel-art color palettes only.
  const store = JSON.parse(localStorage.getItem(IDENTITY_SEQ_KEY) || '{"idx":0}');
  const animalIndex = store.idx % ANIMALS.length;
  store.idx = store.idx + 1;
  localStorage.setItem(IDENTITY_SEQ_KEY, JSON.stringify(store));
  return { animalIndex };
}

class SpriteRenderer {
  constructor(el, charIndex) {
    this.el = el;
    this._frameIdx = 0;
    this._status = 'idle';
    this._raf = null;
    this._lastTs = 0;
    this._FPS = 6;

    const animal = ANIMALS[charIndex % ANIMALS.length];
    const data = SPRITE_DATA[animal];

    el.style.width = '40px';
    el.style.height = '40px';
    el.style.flexShrink = '0';
    el.style.backgroundImage = "url('" + data + "')";
    el.style.backgroundSize = '160px 40px';
    el.style.backgroundRepeat = 'no-repeat';
    el.style.backgroundPosition = '0 0';
    el.style.imageRendering = 'pixelated';
    // No hue filter — sprites use their original pixel-art palette
    // Loop starts only when setStatus transitions to an active state
  }

  setStatus(status) {
    if (this._status === status) return;
    const wasInactive = this._status === 'idle' || this._status === 'error' || this._status === 'waiting';
    this._status = status;
    this._frameIdx = 0;
    this._lastTs = 0; // reset so first frame of new state doesn't skip delay
    this.el.style.backgroundPosition = '0 0'; // snap to frame 0 immediately
    this._FPS = 3;
    // Animate only during active work — waiting/idle/error hold frame 0
    const isInactive = status === 'idle' || status === 'error' || status === 'waiting';
    if (wasInactive && !isInactive && !this._raf) this._startLoop();
  }

  _startLoop() {
    const loop = (ts) => {
      // Self-cancel when inactive — don't keep spinning at 60fps doing nothing
      if (this._status === 'idle' || this._status === 'error' || this._status === 'waiting') {
        this._raf = null;
        return;
      }
      this._raf = requestAnimationFrame(loop);
      if (ts - this._lastTs >= 1000 / this._FPS) {
        this._frameIdx = (this._frameIdx + 1) % 4;
        this.el.style.backgroundPosition = (-this._frameIdx * 40) + 'px 0';
        this._lastTs = ts;
      }
    };
    this._raf = requestAnimationFrame(loop);
  }

  destroy() {
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
  }
}

// ── Self-directory detection ────────────────────────────────
// Walks upward from cwd checking for .pixel-terminal sentinel file.
// Prevents Claude sessions from editing Pixel Terminal's own source files.

async function isSelfDirectory(cwd) {
  const paths = [];
  let dir = cwd.replace(/\/$/, '');
  for (let i = 0; i < 10; i++) {
    paths.push(dir + '/.pixel-terminal');
    const parent = dir.replace(/\/[^/]+$/, '') || '/';
    if (parent === dir) break;
    dir = parent;
  }
  const results = await Promise.all(
    paths.map(p => Command.create('test', ['-f', p]).execute().catch(e => { console.warn('isSelfDirectory check failed:', e); return { code: 1 }; }))
  );
  return results.some(r => r.code === 0);
}

// ── Session state ──────────────────────────────────────────

/** @type {Map<string, Session>} */
const sessions = new Map();

/** @type {Map<string, {messages: Object[]}>} */
const sessionLogs = new Map();

/** @type {Map<string, SpriteRenderer>} — one renderer per session card */
const spriteRenderers = new Map();

let activeSessionId = null;

// Notify the Rust WebSocket bridge of current session state.
// Called on create/kill/switch so OmiWebhook can route "session N" commands.
async function syncOmiSessions() {
  const data = [...sessions.entries()].map(([id, s], i) => ({
    id, name: s.name, index: i + 1, status: s.status,
  }));
  try {
    await invoke('sync_omi_sessions', { sessions: data, active: activeSessionId });
  } catch (_) { /* bridge not available — ignore */ }
}

// ── Session lifecycle ──────────────────────────────────────

async function createSession(cwd, opts = {}) {
  const id    = crypto.randomUUID();
  const name  = cwd.split('/').pop() || cwd;
  const { animalIndex: charIndex } = getNextIdentity();

  sessionLogs.set(id, { messages: [] });

  /** @type {Session} */
  const session = {
    id, cwd, name, charIndex,
    status: 'idle',
    child: null,
    toolPending: {},
    readOnly: !!opts.readOnly,
    unread: false,
    tokens: 0,
    _liveTokens: 0,
    _dotsPhase: 0,
    _pendingMsg: null,
  };
  sessions.set(id, session);

  renderSessionCard(id);
  setActiveSession(id);
  const modeLabel = opts.readOnly ? ' (read-only)' : '';
  pushMessage(id, { type: 'system-msg', text: `Starting in ${cwd}${modeLabel}…` });

  spawnClaude(id); // fire-and-forget — all handling is callback-based
  setStatus(id, 'waiting'); // static "waiting…" during init — no rotating words until user sends
  syncOmiSessions();
  return id;
}

// Spawn (or re-spawn) the Claude CLI process for an existing session.
// Called by createSession on init, and by the Escape handler to restart after interrupt.
async function spawnClaude(id) {
  const s = sessions.get(id);
  if (!s) return;
  try {
    const claudeArgs = [
      '-p',
      '--input-format',  'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'acceptEdits',
    ];
    if (s.readOnly) claudeArgs.push('--disallowed-tools', 'Edit,Write,MultiEdit,NotebookEdit,Bash');
    const cmd = Command.create('claude', claudeArgs, { cwd: s.cwd });

    let _buf = '';
    cmd.stdout.on('data', (chunk) => {
      _buf += chunk;
      const lines = _buf.split('\n');
      _buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try { handleEvent(id, JSON.parse(line)); } catch (_) {}
      }
    });

    cmd.stderr.on('data', (line) => {
      if (line && line.trim()) pushMessage(id, { type: 'error', text: `[stderr] ${line.trim()}` });
    });

    cmd.on('close', (data) => {
      const code = (typeof data === 'object' && data !== null) ? data.code : data;
      s.child = null;
      if (s._interrupting) {
        // Intentional ESC interrupt — suppress error status and "Session ended" message.
        // spawnClaude() already called; this close event is the killed process finishing.
        s._interrupting = false;
        return;
      }
      setStatus(id, code === 0 ? 'idle' : 'error');
      pushMessage(id, { type: 'system-msg', text: `Session ended (exit ${code})` });
    });

    const child = await cmd.spawn();
    s.child = child;
    s.toolPending = {};
    // _pendingMsg is flushed in system/init handler — Claude only reads stdin after that event

  } catch (err) {
    pushMessage(id, { type: 'error', text: `Failed to start Claude Code: ${err}` });
    setStatus(id, 'error');
  }
}

function killSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  try { s.child?.kill(); } catch (_) {}

  spriteRenderers.get(id)?.destroy();
  spriteRenderers.delete(id);

  sessions.delete(id);
  sessionLogs.delete(id);
  document.getElementById(`card-${id}`)?.remove();

  if (activeSessionId === id) {
    const remaining = [...sessions.keys()];
    if (remaining.length > 0) setActiveSession(remaining[remaining.length - 1]);
    else {
      activeSessionId = null;
      showEmptyState();
    }
  }
  syncOmiSessions();
}

// Returns true and shows a warning if text looks like an unrecognized slash command.
// Guard: skips check when _slashCommands is empty (load may have failed).
function warnIfUnknownCommand(id, text) {
  if (!_slashCommands.length) return false; // can't validate — pass through
  const m = text.match(/^\/([^\s\/]+)/);
  if (!m) return false;
  const name = m[1];
  if (_slashCommands.find(c => c.name === name)) return false;
  pushMessage(id, { type: 'warn', text: `Unknown command: /${name}` });
  return true;
}

// Expand /commandname messages by reading the skill file content.
// Only expands if text starts with /name matching a known slash command.
// Shows original text in log — sends expanded content to Claude.
async function expandSlashCommand(text) {
  const m = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!m) return text;
  const [, cmdName, args = ''] = m;
  if (!_slashCommands.find(c => c.name === cmdName)) return text;
  try {
    const body = await invoke('read_slash_command_content', { name: cmdName });
    if (!body) return text;
    return args.trim() ? body + '\n\nARGUMENTS: ' + args.trim() : body;
  } catch (_) {
    return text;
  }
}

async function sendMessage(id, text) {
  const s = sessions.get(id);
  if (!s || !text.trim()) return;

  const raw = text.trim();

  if (warnIfUnknownCommand(id, raw)) return;

  if (!s.child) {
    // Process still spawning — queue until system/init fires.
    // Don't pushMessage yet — show it after "Ready" so log order is correct.
    s._pendingMsg = raw;
    setStatus(id, 'working'); // badge reacts immediately
    return;
  }

  const expanded = await expandSlashCommand(raw);
  pushMessage(id, { type: 'user', text: raw }); // show original in log
  setStatus(id, 'working');

  const line = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: expanded }
  }) + '\n';
  try {
    await s.child.write(line);
  } catch (err) {
    pushMessage(id, { type: 'error', text: 'Send failed — please retry' });
    setStatus(id, 'idle');
  }
}

// ── Event handler ──────────────────────────────────────────

function handleEvent(id, event) {
  const s = sessions.get(id);
  if (!s) return;

  switch (event.type) {

    case 'assistant': {
      // Cancel any pending idle debounce — Claude is still going
      clearTimeout(s._idleTimer);
      if (event.message?.usage) {
        s._lastMsgUsage = event.message.usage;
        const u = event.message.usage;
        // Only count input+output — cache_read recurs every turn (already-counted context),
        // causing exponential inflation. cache_creation has the same problem.
        s._liveTokens = (u.input_tokens || 0) + (u.output_tokens || 0);
      }
      const blocks = event.message?.content || [];

      const texts = blocks.filter(b => b.type === 'text').map(b => b.text);
      if (texts.length) pushMessage(id, { type: 'claude', text: texts.join('\n') });

      for (const b of blocks) {
        if (b.type === 'tool_use') {
          const input = typeof b.input === 'object'
            ? JSON.stringify(b.input, null, 2)
            : String(b.input || '');
          if (!isInternalTool(b.name)) {
            pushMessage(id, { type: 'tool', toolName: b.name, toolId: b.id, input, result: null });
          }
          s.toolPending[b.id] = true;
        }
      }
      setStatus(id, 'working'); // no-op if already working — so always refresh card for live tokens
      updateSessionCard(id);
      break;
    }

    case 'user': {
      const blocks = event.message?.content || [];
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          const resultText = typeof b.content === 'string'
            ? b.content
            : JSON.stringify(b.content);
          const data = sessionLogs.get(id);
          // tool_use always precedes tool_result — scan from end, no reverse copy needed
          const toolMsg = data
            ? data.messages.findLast(m => m.type === 'tool' && m.toolId === b.tool_use_id)
            : null;
          if (toolMsg) {
            toolMsg.result = resultText;
            if (activeSessionId === id) {
              // Targeted update: swap just the status glyph instead of rebuilding all messages
              const log = document.getElementById('message-log');
              const toolEl = log?.querySelector(`[data-tool-id="${b.tool_use_id}"]`);
              if (toolEl) {
                toolEl.querySelector('.tool-status').textContent = '✓';
              }
            }
          }
          delete s.toolPending[b.tool_use_id];
        }
      }
      break;
    }

    case 'result': {
      // Prefer result.usage (per-turn total); fall back to live tokens already shown
      const u = event.usage || s._lastMsgUsage;
      if (u) s.tokens += (u.input_tokens || 0) + (u.output_tokens || 0);
      else s.tokens += s._liveTokens; // result.usage absent and no assistant usage either
      s._liveTokens = 0;
      s._lastMsgUsage = null;
      // Debounce: Claude may immediately start another turn after result.
      // Wait 400ms before going idle so the cursor doesn't flicker between turns.
      clearTimeout(s._idleTimer);
      s._idleTimer = setTimeout(() => {
        setStatus(id, 'idle');
        if (activeSessionId !== id) {
          s.unread = true;
          updateSessionCard(id);
        }
      }, 400);
      break;
    }

    case 'system':
      if (event.subtype === 'init') {
        pushMessage(id, { type: 'system-msg', text: `Ready · ${event.model || 'claude'}` });
        // After ESC restart, always go idle regardless of status.
        // Otherwise: don't clobber 'working' if user queued a message before init.
        if (s._restarting || s.status !== 'working') setStatus(id, 'idle');
        s._restarting = false;
        // Flush message queued before Claude was ready.
        // pushMessage here so it appears AFTER "Ready" in the log.
        if (s._pendingMsg && s.child) {
          const msg = s._pendingMsg;
          s._pendingMsg = null;
          if (warnIfUnknownCommand(id, msg)) break;
          pushMessage(id, { type: 'user', text: msg }); // show original
          expandSlashCommand(msg).then(expanded => {
            if (!s.child) return;
            return s.child.write(JSON.stringify({ type: 'user', message: { role: 'user', content: expanded } }) + '\n');
          }).catch(() => {
            pushMessage(id, { type: 'error', text: 'Failed to send — please resend your message' });
            setStatus(id, 'idle');
          });
        }
      }
      break;

    case 'rate_limit_event':
      pushMessage(id, { type: 'system-msg', text: `Rate limited — retrying…` });
      break;
  }
}

// ── Status ─────────────────────────────────────────────────

function setStatus(id, status) {
  const s = sessions.get(id);
  if (!s || s.status === status) return;
  if (status === 'working') s._dotsPhase = 0; // always start from "" on new working transition
  s.status = status;
  updateSessionCard(id);
  if (activeSessionId === id) updateWorkingCursor(status);
}

// Tools that are Claude Code internal scaffolding — never show in UI
const INTERNAL_TOOLS = new Set([
  'ToolSearch','TodoWrite','TodoRead','AskUserQuestion',
  'TaskCreate','TaskUpdate','TaskList','TaskGet','TaskStop','TaskOutput',
  'ExitPlanMode','EnterPlanMode','NotebookEdit',
  'RemoteTrigger','CronCreate','CronDelete','CronList',
  'ListMcpResourcesTool','ReadMcpResourceTool',
  'EnterWorktree','ExitWorktree',
]);
function isInternalTool(name) {
  return name.startsWith('mcp__') || INTERNAL_TOOLS.has(name);
}

const WORKING_MSGS = [
  'thinking', 'scheming', 'deliberating', 'gallivanting', 'pondering',
  'contemplating', 'ruminating', 'cogitating', 'hypothesizing', 'spelunking',
  'wrangling', 'untangling', 'cross-referencing', 'noodling', 'vibing',
  'consulting the void', 'reading the entrails', 'asking nicely',
  'summoning context', 'doing its thing',
];
let _workingTimer = null;
let _workingMsgIdx = 0;

function updateWorkingCursor(status) {
  const log = document.getElementById('message-log');
  if (!log) return;
  let cur = document.getElementById('working-cursor');
  if (status === 'working') {
    if (!cur) {
      cur = document.createElement('div');
      cur.id = 'working-cursor';
      log.appendChild(cur);
      scheduleScroll();
    }
    // Build cursor structure once, update text node only — avoid innerHTML re-parsing every 3s
    if (!cur.firstChild) {
      const glyph = document.createElement('span');
      glyph.className = 'cursor-blink';
      glyph.textContent = '▋';
      cur.appendChild(glyph);
      cur.appendChild(document.createTextNode(''));
    }
    const textNode = cur.lastChild;
    const setMsg = () => {
      textNode.textContent = ' ' + WORKING_MSGS[_workingMsgIdx++ % WORKING_MSGS.length] + '…';
    };
    setMsg();
    clearInterval(_workingTimer);
    _workingTimer = setInterval(setMsg, 3000);
  } else {
    clearInterval(_workingTimer);
    _workingTimer = null;
    cur?.remove();
  }
}

// ── Message log ────────────────────────────────────────────

// rAF-coalesced scroll — only scrolls if user hasn't manually scrolled up
let _scrollPending = false;
let _pinToBottom = true; // false when user scrolls up; restored when user scrolls back down or sends a message

function scheduleScroll(force = false) {
  if (!force && !_pinToBottom) return;
  if (_scrollPending) return;
  _scrollPending = true;
  requestAnimationFrame(() => {
    _scrollPending = false;
    const log = document.getElementById('message-log');
    if (log) log.lastElementChild?.scrollIntoView({ block: 'end' });
  });
}

function pushMessage(id, msg) {
  const data = sessionLogs.get(id);
  if (!data) return;
  data.messages.push(msg);
  if (activeSessionId === id) {
    const log = document.getElementById('message-log');
    if (log) {
      // Insert BEFORE the working cursor so cursor stays at bottom
      const cursor = document.getElementById('working-cursor');
      const el = createMsgEl(msg);
      el.classList.add('msg-new');
      if (cursor) log.insertBefore(el, cursor);
      else log.appendChild(el);
      scheduleScroll();
    }
  }
}

function renderMessageLog(id) {
  const log = document.getElementById('message-log');
  if (!log) return;
  log.innerHTML = ''; // cursor gets wiped here — restore below
  const data = sessionLogs.get(id);
  if (data) {
    // DocumentFragment: build all elements off-DOM, single reflow on append
    const frag = document.createDocumentFragment();
    for (const msg of data.messages) frag.appendChild(createMsgEl(msg));
    log.appendChild(frag);
  }
  // Always restore cursor to match current session status
  const s = sessions.get(id);
  if (s && s.status === 'working') {
    updateWorkingCursor(s.status);
  }
  scheduleScroll();
}

function createMsgEl(msg) {
  const el = document.createElement('div');
  el.className = `msg ${msg.type}`;

  if (msg.type === 'user') {
    el.innerHTML = `<div class="msg-bubble">${esc(msg.text)}</div>`;

  } else if (msg.type === 'claude') {
    // Cache parsed HTML — msg.text is immutable after creation
    if (!msg._html) {
      const normalized = msg.text.replace(/\n\n(?=[ \t]*(?:\d+[.)]\s|[-*+]\s))/g, '\n');
      msg._html = mdParse(normalized);
    }
    el.innerHTML = `<div class="msg-bubble">${msg._html}</div>`;
    // Orange for the last paragraph regardless of trailing hr/empty nodes
    const paras = el.querySelectorAll('.msg-bubble p');
    if (paras.length) paras[paras.length - 1].style.color = '#e8820c';

  } else if (msg.type === 'tool') {
    const icon = toolIcon(msg.toolName);
    // Cache hint — msg.input is immutable after creation
    if (msg._hint === undefined) msg._hint = toolHint(msg.toolName, msg.input);
    const hint = msg._hint;
    const hasResult = msg.result !== null && msg.result !== undefined;
    const status = hasResult ? '✓' : '…';
    el.dataset.toolId = msg.toolId;
    el.innerHTML = `<div class="tool-line">${icon} <span class="tool-name">${esc(msg.toolName)}</span>${hint ? ` <span class="tool-hint">${esc(hint)}</span>` : ''} <span class="tool-status">${status}</span></div>`;

  } else if (msg.type === 'system-msg') {
    el.innerHTML = `<div class="system-label">${esc(msg.text)}</div>`;

  } else if (msg.type === 'error') {
    el.innerHTML = `<div class="error-msg">${esc(msg.text)}</div>`;
  } else if (msg.type === 'warn') {
    el.innerHTML = `<div class="warn-msg">${esc(msg.text)}</div>`;
  }

  return el;
}

// ── Token formatting ────────────────────────────────────────

function formatTokens(n) {
  const t = n || 0;
  if (t < 1_000_000) return '~' + Math.round(t / 1000) + 'K';
  return '~' + (t / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}

// ── Session cards ──────────────────────────────────────────

function renderSessionCard(id) {
  const s = sessions.get(id);
  if (!s) return;

  const card = document.createElement('div');
  card.className = 'session-card';
  card.id = `card-${id}`;
  card.innerHTML = `
    <div class="session-card-top">
      <div class="sprite-wrap" id="card-sprite-wrap-${id}"></div>
      <div class="session-card-info">
        <div class="session-card-name">${esc(s.name)}</div>
        <div class="session-card-tokens" id="card-tokens-${id}"></div>
      </div>
      <span class="card-badge" id="card-status-${id}"></span>
    </div>
    <button class="session-card-kill" title="Kill session" data-id="${id}">✕</button>
  `;

  card.addEventListener('click', (e) => {
    if (e.target.closest('.session-card-kill')) return;
    setActiveSession(id);
  });
  card.querySelector('.session-card-kill').addEventListener('click', async (e) => {
    e.stopPropagation();
    const ok = await showConfirm(`Terminate "${s.name}"? This will end the session.`);
    if (ok) killSession(id);
  });
  document.getElementById('session-list').appendChild(card);

  // Attach sprite renderer to the wrap div
  const wrap = document.getElementById(`card-sprite-wrap-${id}`);
  spriteRenderers.set(id, new SpriteRenderer(wrap, s.charIndex));
}

function updateSessionCard(id) {
  const s = sessions.get(id);
  if (!s) return;

  spriteRenderers.get(id)?.setStatus(s.status);

  const statusEl = document.getElementById(`card-status-${id}`);
  if (statusEl) {
    if (s.unread) {
      statusEl.textContent = 'NEW';
      statusEl.className = 'card-badge unread';
    } else {
      const label = { idle: 'IDLE', error: 'ERR', working: '.'.repeat(s._dotsPhase || 0), waiting: '···' }[s.status] ?? '···';
      statusEl.textContent = label;
      statusEl.className = `card-badge ${s.status}`;
    }
    statusEl.style.display = '';
  }

  const tokensEl = document.getElementById(`card-tokens-${id}`);
  if (tokensEl) {
    tokensEl.textContent = formatTokens(s.tokens + (s._liveTokens || 0));
  }

  const card = document.getElementById(`card-${id}`);
  if (card) card.classList.toggle('active', activeSessionId === id);
}

// ── Session switching ──────────────────────────────────────

function setActiveSession(id) {
  const prev = activeSessionId;
  activeSessionId = id;
  _pinToBottom = true;
  const viewedSession = sessions.get(id);
  if (viewedSession) viewedSession.unread = false;
  if (prev && prev !== id) updateSessionCard(prev);
  updateSessionCard(id);
  showChatView();
  renderMessageLog(id);
  const s = sessions.get(id);
  if (s) updateWorkingCursor(s.status);
  document.getElementById('msg-input')?.focus();
  syncOmiSessions();
}

// ── View helpers ───────────────────────────────────────────

function showEmptyState() {
  document.getElementById('message-log').innerHTML = '';
}

function showChatView() {
  // intentionally no-op — never disable controls in a terminal app
}


// ── Util ───────────────────────────────────────────────────

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function toolIcon(name = '') {
  return '·';
}

function toolHint(name, inputStr) {
  try {
    const obj = JSON.parse(inputStr);
    const n = name.toLowerCase();
    // File/path tools
    if (obj.file_path) return obj.file_path.replace(/.*\//, '');
    if (obj.path) return obj.path.replace(/.*\//, '');
    if (obj.pattern) return obj.pattern;
    if (obj.command) return String(obj.command).slice(0, 60);
    // Memory tools
    if (obj.query_texts) return obj.query_texts[0]?.slice(0, 50);
    if (obj.collection && obj.documents) return obj.collection;
    // Web
    if (obj.url) return obj.url.replace(/^https?:\/\//, '').slice(0, 50);
    if (obj.query) return String(obj.query).slice(0, 50);
    // Figma
    if (obj.node_id) return `node:${obj.node_id}`;
    if (obj.name) return String(obj.name).slice(0, 50);
    // Generic: first string value
    const first = Object.values(obj).find(v => typeof v === 'string');
    return first ? first.slice(0, 50) : '';
  } catch (_) {
    return String(inputStr || '').slice(0, 50);
  }
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

// ── Confirm modal ──────────────────────────────────────────

function showConfirm(message, okLabel = 'terminate') {
  return new Promise((resolve) => {
    const overlay = document.getElementById('confirm-overlay');
    document.getElementById('confirm-msg').textContent = message;
    document.getElementById('confirm-ok').textContent = okLabel;
    overlay.classList.remove('hidden');

    function onOk()    { cleanup(); resolve(true);  }
    function onCancel(){ cleanup(); resolve(false); }
    function onKey(e)  {
      if (e.key === 'Enter')  { e.preventDefault(); onOk(); }
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    }

    function cleanup() {
      overlay.classList.add('hidden');
      document.getElementById('confirm-ok').removeEventListener('click', onOk);
      document.getElementById('confirm-cancel').removeEventListener('click', onCancel);
      window.removeEventListener('keydown', onKey);
    }

    document.getElementById('confirm-ok').addEventListener('click', onOk);
    document.getElementById('confirm-cancel').addEventListener('click', onCancel);
    window.addEventListener('keydown', onKey);
  });
}

// ── Folder picker ──────────────────────────────────────────

async function pickFolder() {
  try {
    const dir = await openDialog({ directory: true, multiple: false, title: 'Choose Project Folder' });
    if (!dir) return;
    if (await isSelfDirectory(dir)) {
      const proceed = await showConfirm(
        "This is Pixel Terminal's own source directory.\nEditing files here will crash all running sessions.\nProceed in read-only mode?",
        'proceed read-only'
      );
      if (!proceed) return;
      await createSession(dir, { readOnly: true });
    } else {
      await createSession(dir);
    }
  } catch (err) {
    console.error('Folder picker error:', err);
  }
}

// ── Slash command / flag autocomplete menu ──────────────────

let _slashCommands = [];    // loaded once on startup
let _slashActiveIdx = -1;   // keyboard-highlighted row
let _activeToken   = null;  // token that opened the menu

const FLAG_ITEMS = [
  { name: 'seq',        description: 'sequential-thinking MCP — structured multi-step reasoning' },
  { name: 'think',      description: 'pause and reason carefully before responding' },
  { name: 'think-hard', description: '--think + --seq combined' },
  { name: 'ultrathink', description: '--think-hard + explicit plan before acting' },
  { name: 'uc',         description: 'ultra-compressed output' },
  { name: 'no-mcp',     description: 'disable all MCP servers' },
  { name: 'grade',      description: 'grade current plan (use with /sm:introspect)' },
  { name: 'quick',      description: 'fast bootstrap — skip memory queries' },
  { name: 'cold',       description: 'fresh start, skip project memory' },
  { name: 'retro',      description: 'end-of-session retro (use with /checkpoint)' },
  { name: 'dry-run',    description: 'show what would happen without writing' },
  { name: 'state-only', description: 'write STATE.md only (use with /checkpoint)' },
  { name: 'brief',      description: 'meeting/pitch brief mode (use with /research)' },
];

async function loadSlashCommands() {
  try {
    _slashCommands = await invoke('read_slash_commands');
  } catch (_) {
    _slashCommands = [];
  }
}

function showSlashMenu(token) {
  _activeToken = token;
  const menu = document.getElementById('slash-menu');
  const q = token.query.toLowerCase();

  let matches, prefix;
  if (token.type === 'flag') {
    matches = FLAG_ITEMS.filter(f =>
      f.name.toLowerCase().includes(q) || f.description.toLowerCase().includes(q)
    );
    prefix = '--';
  } else {
    matches = _slashCommands.filter(c =>
      c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)
    );
    prefix = '/';
  }

  if (!matches.length) { hideSlashMenu(); return; }

  // Position flush against the top of the input bar, right of the sidebar
  const inputBar = document.getElementById('input-bar');
  const sidebar  = document.getElementById('sidebar');
  const rect = inputBar.getBoundingClientRect();
  menu.style.bottom = (window.innerHeight - rect.top) + 'px';
  menu.style.left   = (sidebar.offsetWidth + 1) + 'px'; // +1 for resize handle

  _slashActiveIdx = -1;
  menu.innerHTML = matches.map((c, i) =>
    `<div class="slash-item" data-idx="${i}" data-name="${esc(c.name)}">` +
    `<span class="slash-item-name">${prefix}${esc(c.name)}</span>` +
    `<span class="slash-item-desc">${esc(c.description)}</span>` +
    `</div>`
  ).join('');

  menu.querySelectorAll('.slash-item').forEach(el => {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault(); // don't blur input
      acceptSlashItem(el.dataset.name);
    });
  });

  menu.classList.remove('hidden');
}

function hideSlashMenu() {
  document.getElementById('slash-menu').classList.add('hidden');
  _slashActiveIdx = -1;
}

function moveSlashSelection(delta) {
  const menu = document.getElementById('slash-menu');
  const items = menu.querySelectorAll('.slash-item');
  if (!items.length) return;
  items[_slashActiveIdx]?.classList.remove('active');
  _slashActiveIdx = Math.max(0, Math.min(items.length - 1, _slashActiveIdx + delta));
  const active = items[_slashActiveIdx];
  active.classList.add('active');
  active.scrollIntoView({ block: 'nearest' });
}

// Returns { start, end, query, type:'slash' } for a /word at cursor, or null.
// Only matches if / is at start of input or preceded by a space (not mid-URL).
function getSlashToken(input) {
  const val = input.value;
  const pos = input.selectionStart;
  let slashPos = -1;
  for (let i = pos - 1; i >= 0; i--) {
    if (val[i] === '/') {
      if (i === 0 || val[i - 1] === ' ') { slashPos = i; break; }
    } else if (val[i] === ' ') {
      break;
    }
  }
  if (slashPos === -1) return null;
  const query = val.slice(slashPos + 1, pos);
  if (query.includes(' ')) return null;
  return { start: slashPos, end: pos, query, type: 'slash' };
}

// Returns { start, end, query, type:'flag' } for a --word at cursor, or null.
// Only matches if -- is at start of input or preceded by a space.
function getFlagToken(input) {
  const val = input.value;
  const pos = input.selectionStart;
  if (pos < 2) return null;
  let dashPos = -1;
  for (let i = pos - 1; i >= 1; i--) {
    if (val[i] === '-' && val[i - 1] === '-') {
      if (i - 1 === 0 || val[i - 2] === ' ') { dashPos = i - 1; break; }
    } else if (val[i] === ' ') {
      break;
    }
  }
  if (dashPos === -1) return null;
  const query = val.slice(dashPos + 2, pos);
  if (query.includes(' ') || query.startsWith('-')) return null;
  return { start: dashPos, end: pos, query, type: 'flag' };
}

function acceptSlashItem(name) {
  const input = document.getElementById('msg-input');
  const token = _activeToken;
  const prefix = token?.type === 'flag' ? '--' : '/';
  if (token) {
    const val = input.value;
    const newVal = val.slice(0, token.start) + prefix + name + ' ' + val.slice(token.end);
    input.value = newVal;
    const newPos = token.start + prefix.length + name.length + 1;
    input.setSelectionRange(newPos, newPos);
  } else {
    input.value = prefix + name + ' ';
  }
  input.focus();
  hideSlashMenu();
  autoResize(input);
}

function acceptActiveSlashItem() {
  const menu = document.getElementById('slash-menu');
  const items = menu.querySelectorAll('.slash-item');
  const idx = _slashActiveIdx >= 0 ? _slashActiveIdx : 0;
  if (items[idx]) acceptSlashItem(items[idx].dataset.name);
}

// ── Bootstrap ──────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {

  // One-time cleanup: remove stale flags that shouldn't persist across sessions
  localStorage.removeItem('alwaysOn');
  localStorage.removeItem('omiListening');
  localStorage.removeItem(IDENTITY_SEQ_KEY); // reset sprite sequence on each app launch

  loadSlashCommands();

  // Animate working badge: per-session phase cycles "" "." ".." "..." every 400ms
  setInterval(() => {
    sessions.forEach((s, id) => {
      if (s.status === 'working' && !s.unread) {
        s._dotsPhase = (s._dotsPhase + 1) % 4;
        const el = document.getElementById(`card-status-${id}`);
        if (el) el.textContent = '.'.repeat(s._dotsPhase);
      }
    });
  }, 400);

  // Open links in system browser — prevent Tauri webview from navigating away
  document.getElementById('message-log').addEventListener('click', (e) => {
    const link = e.target.closest('a[href]');
    if (!link) return;
    const href = link.getAttribute('href');
    if (!href || href.startsWith('#')) return;
    e.preventDefault();
    window.__TAURI__.opener.openUrl(href);
  });

  // Track whether user has scrolled up — suppress auto-scroll if so
  document.getElementById('message-log').addEventListener('scroll', () => {
    const log = document.getElementById('message-log');
    _pinToBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 40;
  });

  // Sidebar resize
  const sidebar = document.getElementById('sidebar');
  const resizeHandle = document.getElementById('sidebar-resize');
  let _resizing = false, _resizeStartX = 0, _resizeStartW = 0;
  let _resizeRafId = null, _resizeW = 0;
  resizeHandle.addEventListener('mousedown', (e) => {
    _resizing = true;
    _resizeStartX = e.clientX;
    _resizeStartW = sidebar.offsetWidth;
    resizeHandle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!_resizing) return;
    _resizeW = Math.max(80, Math.min(340, _resizeStartW + (e.clientX - _resizeStartX)));
    if (!_resizeRafId) {
      _resizeRafId = requestAnimationFrame(() => {
        sidebar.style.width = _resizeW + 'px';
        _resizeRafId = null;
      });
    }
  });
  window.addEventListener('mouseup', () => {
    if (!_resizing) return;
    _resizing = false;
    // Flush any pending RAF and apply the final width immediately
    if (_resizeRafId) { cancelAnimationFrame(_resizeRafId); _resizeRafId = null; sidebar.style.width = _resizeW + 'px'; }
    resizeHandle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  document.getElementById('btn-new-session').addEventListener('click', pickFolder);
  showEmptyState(); // input disabled until first session opens

  document.getElementById('btn-send').addEventListener('click', () => {
    const input = document.getElementById('msg-input');
    const text = input.value;
    if (!text.trim() || !activeSessionId) return;
    input.value = '';
    input.style.height = ''; // reset to rows="1" — avoids WebKit scrollHeight=0 collapse
    _pinToBottom = true;
    hideSlashMenu();
    sendMessage(activeSessionId, text);
  });

  document.getElementById('msg-input').addEventListener('keydown', (e) => {
    const menuVisible = !document.getElementById('slash-menu').classList.contains('hidden');
    if (menuVisible) {
      if (e.key === 'ArrowDown')  { e.preventDefault(); moveSlashSelection(1); return; }
      if (e.key === 'ArrowUp')    { e.preventDefault(); moveSlashSelection(-1); return; }
      if (e.key === 'Tab') {
        e.preventDefault(); acceptActiveSlashItem(); return;
      }
      if (e.key === 'Enter' && !e.shiftKey && _slashActiveIdx >= 0) {
        // Only accept if user explicitly navigated to an item with arrow keys
        e.preventDefault(); acceptActiveSlashItem(); return;
      }
      if (e.key === 'Escape')     { e.preventDefault(); hideSlashMenu(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const input = document.getElementById('msg-input');
      const text = input.value;
      if (!text.trim() || !activeSessionId) return;
      input.value = '';
      input.style.height = '';
      _pinToBottom = true;
      hideSlashMenu();
      sendMessage(activeSessionId, text);
    }
  });

  document.getElementById('msg-input').addEventListener('input', (e) => {
    autoResize(e.target);
    const token = getSlashToken(e.target) || getFlagToken(e.target);
    if (token) {
      showSlashMenu(token);
    } else {
      hideSlashMenu();
    }
  });

  // Click outside slash menu → close it
  document.addEventListener('mousedown', (e) => {
    const menu = document.getElementById('slash-menu');
    const input = document.getElementById('msg-input');
    if (!menu.classList.contains('hidden') &&
        !menu.contains(e.target) && e.target !== input) {
      hideSlashMenu();
    }
  });

  // Esc — cancel active Claude operation
  // Guards (in priority order): slash menu, confirm modal, settings panel
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!document.getElementById('slash-menu').classList.contains('hidden')) return; // slash menu: handled by its own listener
    if (!document.getElementById('confirm-overlay')?.classList.contains('hidden')) return; // confirm modal: has its own Esc handler
    if (settingsOpen) { settingsOpen = false; _settingsUpdate(); return; } // close settings panel, don't kill Claude
    if (activeSessionId) {
      const s = sessions.get(activeSessionId);
      if (s && s.child && (s.status === 'working' || s.status === 'waiting')) {
        e.preventDefault();
        s._interrupting = true;
        try { s.child.kill(); } catch (_) {}
        s.child = null;
        clearTimeout(s._idleTimer);
        pushMessage(activeSessionId, { type: 'system-msg', text: 'Interrupted — restarting…' });
        setStatus(activeSessionId, 'waiting');
        s._restarting = true;
        spawnClaude(activeSessionId);
      }
    }
  });

  // Cmd+1-5 to switch sessions
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key >= '1' && e.key <= '5') {
      e.preventDefault();
      const ids = [...sessions.keys()];
      const target = ids[parseInt(e.key) - 1];
      if (target) setActiveSession(target);
    }
  });

  // ── Omi voice bridge ───────────────────────────────────────
  // Listens for voice commands from OmiWebhook via the Rust WebSocket bridge.
  // "hey pixel, <text> full stop" → sendMessage to targeted session.
  // Dot = clickable toggle. Green=listening, amber=muted, gray=disconnected.

  const { listen: tauriListen } = window.__TAURI__.event;

  let omiConnected = false;
  let omiListening = true; // always start listening — don't restore mute from storage
  // voiceSource declared here so _omiIndicatorUpdate can read it
  let voiceSource = localStorage.getItem('voiceSource') || 'ble';

  function _omiIndicatorUpdate() {
    const el = document.getElementById('omi-indicator');
    if (!el) return;
    el.classList.remove('connected');
    if (omiConnected) {
      el.classList.add('connected');
      el.title = 'Omi connected — click for settings (fn = push to talk)';
    } else {
      el.title = 'Omi voice bridge disconnected — click for settings';
    }
  }

  function toggleOmiListening() {
    omiListening = !omiListening;
    _omiIndicatorUpdate();
    try { invoke('set_omi_listening', { enabled: omiListening }); } catch (_) {}
  }

  document.getElementById('omi-indicator')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const el = document.getElementById('omi-indicator');
    if (omiConnected) {
      // Already connected — flash status
      _showDotStatus('Voice bridge connected');
    } else {
      // Launch the voice bridge via launch.command
      const home = await window.__TAURI__.path.homeDir();
      const script = `${home}Projects/pixel-terminal/launch.command`;
      Command.create('open', [script]).execute().catch(() => {
        _showDotStatus('Run launch.command to connect');
      });
    }
  });

  function _showDotStatus(msg) {
    const el = document.getElementById('omi-indicator');
    if (!el) return;
    const prev = el.title;
    el.title = msg;
    setTimeout(() => { el.title = prev; }, 2500);
  }

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'O') {
      e.preventDefault();
      toggleOmiListening();
    }
  });

  function resolveSession(ref) {
    if (ref == null) return activeSessionId;
    if (typeof ref === 'number') {
      const keys = [...sessions.keys()];
      return keys[ref - 1] || activeSessionId;
    }
    const needle = String(ref).toLowerCase();
    for (const [id, s] of sessions) {
      if (s.name.toLowerCase().includes(needle)) return id;
    }
    return activeSessionId;
  }

  tauriListen('omi:command', (event) => {
    const { type, text, session, ts, dispatched } = event.payload;

    // Transcript events only show in voice log when bridge is connected (green dot)
    if (type === 'transcript') {
      if (omiConnected && omiListening) appendVoiceLog(text, ts, dispatched);
      return;
    }

    if (!omiListening) return;  // JS-side mute guard — commands only

    const targetId = resolveSession(session ?? null);
    if (!targetId) return;
    if (type === 'prompt') {
      sendMessage(targetId, text);
    } else if (type === 'switch') {
      setActiveSession(targetId);
    } else if (type === 'list_sessions') {
      const lines = [...sessions.entries()]
        .map(([_, s], i) => `${i + 1}. ${s.name} [${s.status}]`)
        .join('\n');
      pushMessage(activeSessionId, { type: 'system-msg', text: `Omi sessions:\n${lines}` });
    }
  });

  // ── Voice log (transcript sidebar) ────────────────────────
  const MAX_VOICE_LOG = 200;

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function appendVoiceLog(text, ts, dispatched) {
    const log = document.getElementById('voice-log');
    if (!log || !text) return;
    const entry = document.createElement('div');
    entry.className = 'voice-entry' + (dispatched ? ' dispatched' : '');
    entry.innerHTML = `<span class="ts">${escapeHtml(ts || '')}</span>${dispatched ? '▶ ' : ''}${escapeHtml(text)}`;
    log.appendChild(entry);
    while (log.children.length > MAX_VOICE_LOG) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  }

  document.getElementById('btn-clear-voice-log')?.addEventListener('click', () => {
    const log = document.getElementById('voice-log');
    if (log) log.innerHTML = '';
  });

  tauriListen('omi:connected', () => {
    omiConnected = true;
    _omiIndicatorUpdate();
    // Re-send current mute state so a reconnecting OmiWebhook stays in sync
    try { invoke('set_omi_listening', { enabled: omiListening }); } catch (_) {}
    // Always sync voice mode on reconnect (trigger_mode unless OPEN was clicked this session)
    try { invoke('set_voice_mode', { mode: alwaysOn ? 'always_on' : 'trigger_mode' }); } catch (_) {}
  });

  tauriListen('omi:disconnected', () => {
    omiConnected = false;
    _omiIndicatorUpdate();
  });

  // ── Always-on mic toggle ───────────────────────────────────
  // When active, pixel_voice_bridge skips "hey pixel" trigger —
  // every transcribed utterance (3s silence timeout) is sent as a command.

  let alwaysOn = false; // PTT-only: never restore always-on from storage — fn key is the activation path

  function _alwaysOnUpdate() {
    const el = document.getElementById('always-on-btn');
    if (!el) return;
    if (alwaysOn) {
      el.classList.add('active');
      el.title = 'Always-on mic active — click to return to trigger mode (Ctrl+Shift+A)';
    } else {
      el.classList.remove('active');
      el.title = 'Always-on mic off — no "hey pixel" needed when on (Ctrl+Shift+A)';
    }
  }

  function toggleAlwaysOn() {
    alwaysOn = !alwaysOn;
    _alwaysOnUpdate();
    try { invoke('set_voice_mode', { mode: alwaysOn ? 'always_on' : 'trigger_mode' }); } catch (_) {}
  }

  document.getElementById('always-on-btn')?.addEventListener('click', toggleAlwaysOn);

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'A') {
      e.preventDefault();
      toggleAlwaysOn();
    }
  });

  _alwaysOnUpdate(); // restore persisted state on load

  // ── fn key PTT (push-to-talk) ────────────────────────────────────────────
  // Hold fn → bridge starts transcribing (ptt_start). Dot pulses.
  // Release fn → bridge fires gathered buffer immediately (ptt_release).
  // Right Option (AltRight) is a fallback if fn is intercepted by macOS.
  // PTT is independent of alwaysOn — does not modify that flag.
  let pttActive = false;

  function _isPttKey(e) {
    return e.key === 'Fn' || e.code === 'Fn' || e.code === 'AltRight';
  }

  function _pttIndicatorUpdate() {
    const el = document.getElementById('omi-indicator');
    if (!el) return;
    if (pttActive) {
      el.classList.add('ptt');
    } else {
      el.classList.remove('ptt');
    }
  }

  document.addEventListener('keydown', (e) => {
    if (!_isPttKey(e)) return;
    if (pttActive) return;     // already recording
    if (!omiConnected) return; // no bridge
    pttActive = true;
    try { invoke('ptt_start'); } catch (_) {}
    _pttIndicatorUpdate();
  });

  document.addEventListener('keyup', (e) => {
    if (!_isPttKey(e)) return;
    if (!pttActive) return;
    pttActive = false;
    try { invoke('ptt_release'); } catch (_) {}
    _pttIndicatorUpdate();
  });

  // ── Voice settings panel ────────────────────────────────────────────────
  let settingsOpen = false;

  function _settingsUpdate() {
    const panel = document.getElementById('settings-panel');
    const btn = document.getElementById('settings-btn');
    const bleBtn = document.getElementById('voice-source-ble');
    const micBtn = document.getElementById('voice-source-mic');
    if (!panel) return;
    panel.classList.toggle('hidden', !settingsOpen);
    btn?.classList.toggle('open', settingsOpen);
    bleBtn?.classList.toggle('active', voiceSource === 'ble');
    micBtn?.classList.toggle('active', voiceSource === 'mic');
  }

  document.getElementById('settings-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    settingsOpen = !settingsOpen;
    _settingsUpdate();
  });

  document.addEventListener('click', () => {
    if (settingsOpen) { settingsOpen = false; _settingsUpdate(); }
  });

  document.getElementById('settings-panel')?.addEventListener('click', (e) => {
    e.stopPropagation(); // prevent panel click from closing itself
  });

  function _switchVoiceSource(source) {
    voiceSource = source;
    localStorage.setItem('voiceSource', voiceSource);
    _settingsUpdate();
    _omiIndicatorUpdate();  // refresh dot color (blue=BLE, green=mic)
    const label = source === 'ble' ? 'BLE pendant' : 'Mac mic';
    appendVoiceLog(`Switching to ${label} — reconnecting...`, new Date().toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'}), false);
    try { invoke('switch_voice_source', { source }); } catch (_) {}
  }

  document.getElementById('voice-source-ble')?.addEventListener('click', () => _switchVoiceSource('ble'));
  document.getElementById('voice-source-mic')?.addEventListener('click', () => _switchVoiceSource('mic'));

  _settingsUpdate(); // restore persisted state on load

  // Window close (red X) — HTML confirm modal
  const appWindow = window.__TAURI__.window.getCurrentWindow();
  let _forceClose = false;
  appWindow.onCloseRequested(async (event) => {
    if (_forceClose) return;
    event.preventDefault();
    const count = sessions.size;
    const msg = count > 0
      ? `Close Pixel Terminal? ${count} session${count > 1 ? 's' : ''} will be terminated.`
      : 'Close Pixel Terminal?';
    const ok = await showConfirm(msg);
    if (ok) {
      _forceClose = true;
      for (const [id] of sessions) {
        try { sessions.get(id)?.child?.kill(); } catch (_) {}
      }
      appWindow.close();
    }
  });
});
