// ── Session state + sprites ────────────────────────────────

const { Command } = window.__TAURI__.shell;
const { invoke } = window.__TAURI__.core;

const SPRITE_DATA = {
  'cat': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAABTElEQVR4nGNgGAWjYBTgApxcIv/x8Qe7fooAJ5fI//stS/+DaBiG8YeCfpgZ+PggwMiAA4AUGzjYgNnPnzwH05IykgwXDhxh+P7tDU596PqR9YIAqfopsf9a1UQGrbZ8uBiMj6yfBZ8hIItBlsIcTw5A1gvzCLGAUvujjq1mQI4EEB8dMGHTCEsqIIvXlyvAHQNjE0qGMHmQepjlIDbMI8TqJ9d+GEBOObgCkQndYhBGTiIWucfBBu0PywOzQQBXEkTXD1IP0gfSD9NLin5y7SclAJmw5TmYJaD8Bgs5x1WTGF7euYvXcnT9IPUgfcTkX2raT0oAMmEzDGaguIoy3PEgDLKAlFIcpB85+ZGjn1z7iQ1AJnyGwDSDQpDUAmyg9RMbgEzoGmGKYJpJBYNJPzEByISeZJABSNMyq1Bw0gFhEBsXGOr6RwHDCAUAGpNqzZQe1mUAAAAASUVORK5CYII=',
  'rabbit': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAAA9klEQVR4nGNgGAWjYBQgA04ukf8gjItPKiBVP7XtJwSYsAmeW90AthgXn1RAqn5K7Cc1AJmIdRQpltMyxqgdgCz4DCI16YIsggGj0AaKA4EeAcmCLvD92xtGkOOX5DrDxa4dOkyUYUahiAAgRz+l9pMTgEz4JGMm70WhCTkchsnRT6n9yO4ARQQoAGEYXwAy4TMMlKSNeP3ANDlgoPUTE4CM+JIPLBmCDECOWWLAQOqH6dWys2XgOC/I8MPwPTh7YjODCV3g+tYp4FIcOQ+C2MQWSAOtHwRAKQYUaKCkf+7zJpyexwlAlsEcgsweKfpHwShgGDkAAJoz5Ga0OakEAAAAAElFTkSuQmCC',
  'penguin': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAAACXBIWXMAAAsTAAALEwEAmpwYAAABF0lEQVRYhWP8//8/w0gGTAwjHDAxjHDAxDDCARPDCAcsuCS4uEVRSsdvX18z0sVFVLSfKDP+//+PgTm5RP6rWsX9f/32JRyDxLCpxYVB6pExqXqpYT8xZjDg0gzTAKNJcQClHqDUflLMYMKXhB49vsrwfmYow8UaLVJTH8Oxzd0McrLaYDaMJhVQYj/RZvynYQyC8K02OzCmZwoixQwmbAWHjIEXRkCBxNALFXzAyrcUTAumrwZjYgGl9oPUqFnHg80ApUJ096ADJmyCTy5swynGyMiIFxPyACH9lNpPSD/BAPj+7Q3O6gafHCHLcDmA2vaTqp8Fl+KtPg/ghRcphRDIElBew6af2ACkxH5S9TOO9gYZRjYAADtGhP+ePrhdAAAAAElFTkSuQmCC',
  'crab': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAAA60lEQVR4nGNgGAWjYBSMgmEEOLlE/oMwseJMlBpAbUCJ/SD5OWoyOOVBcuhmsOAyIOUWw//v394w4hPH5QgQja4Glzi17ScVMGETTLn1hCgxdABzKHpI4xLHBci1H90t2NhEBcAcLMkIX9KitgcotZ8U/UzYBEGOffT4Kjzfgdj09ACl9lOkn5NL5P9SA4P/MBqZTUwhBFP3+u1LMI3MJtUMUu0nRz8TuuZjvhrg0ALRMIAsRsgRIHWg2JaT1QbTyGxCsUCp/eToZyHkGbAB6gjDCAGQJVabb8BpXGLEAHLsp6b+UTAKGIY/AADH7fC4BIq4LgAAAABJRU5ErkJggg==',
  'rat': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAABTElEQVR4nGNgGAWjYBSMZMCIS4KTS+Q/jP392xtGXGK0AJTaTYp+FnwGFdrpgun+Q5f/o/Fp7glK7CZFPyMhT2gLCaOIXX33lqjYB+lFtxSZT0wskms3KfqZiDFstrUoCk0MAFkE8uiuK88YQA4BYRCbGM9TajcpepmIMWj1R1YGNx0pMA2KReSkjAxKVSz+gzA5DqHUbmypD1kvLsCI7gEQ3X3nBCO2ZLR4Zi6DUWgDzhh0lDX8v//xeUaQOSAzYPpBjkAG2FIBpXZj039udQNDbPpk4rOQo6wh2BDkWAQZZCKj/r/Kw/E/odBHj32YXhi+vnUKTjMotRuXfpBekBm49DMhc0zY2RmwxQIsBkFsfA4B6QM5AOQYEA0KbVCog/SDML4YpNRuXPpBAGQGIf1wgOwBWAiCaGQ2A5GAVP2U2k1Nt4+CUcAwMgAAymMvotX5iBgAAAAASUVORK5CYII=',
  'seal': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAAAxklEQVR4nGNgGAWjYBSMghEMGAkp4OQS+Y/M//7tDUE91DSDUvsJ6WckpLmitwlFrKO4jmQPkGsGpfYTo5+JGINAmpBpcgAlZtBSLxNyaMGSCzIbBPYd3cGwY/MuMI0L4NNPjBm0sp8YvWAA0tA4fdp/ZBpZHFmMXP34zKCH/dj0M2LLM7B8AuL7ZSQzaKnKE5UHh6J+JnRDrt1+yAAyBJtmYsBQ08+ILgDTCAMFsaEMTtYeYDYoH4HY+Erhoa5/FIwChpEFAKM3JDuNyYkcAAAAAElFTkSuQmCC',
  'snake': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAABHUlEQVR4nGNgGOGAkWEYAk4ukf/I/O/f3jCOmADg5BL5X6iTznDs4zUGK34tMH3y8WGcgcCEyxBkTK5DyDWDUvv7r8wEex5G4wOMlIYgLg+Qawal9sP0wwDJ7ueEhnqVWTUKTZRmKphBTfuJ0c+ETRAWgrCYIAdQYgal9sNi+/72GPLcz0lCCNLCDGrZ/+JgAXkp4DulIUihGdSwHwYI6WciZAChUhQXAIU6yAOTSrlJLkSpYT+x+lmQOdiSCiwEkeVweWag9WMzB1k/Nn1MyJpAhQ4o1kAYPQTNZW3BhRKIxubQgdaPbg42/dj0MWILNRhAdggMgJI0qIGBHpoDrR+bOcj6celjxGYIPkeBACmNksGkn9xyaBQwDGMAAKNsPyaqyIfWAAAAAElFTkSuQmCC',
  'cat2': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAAACXBIWXMAAAsTAAALEwEAmpwYAAABuElEQVRYhe1XsUoDQRDdW4JoAoKgQiy1EcFS/AAbGy0EfyB10N5axDZiq50/EBH8hWAnIjZiIyoqCNGcYrPy1rxlOfY2u4mFcj4YspOZt7NvmNtLEqWUKDKkKDikKDqUUrk2Uh5XPt9lNpDv83thUL4P5rzKI/5m+0jhk0Y/pAE+fqj4QfjcI8/neUu+DV4fdkWrVhVX6bDxY4D8/eVRvV6YqvTFR/2zu050fYi93GqIuZ1NI5r+e/qc8LuSb5Prl08xMzYkZssfol9AOEEhoUA++PYeP91A6SKWKxO6axA/ub5kDsM14y50H5821shncawppNcYM458V/3Qx4C1fU2UWeGwtPNkRuSk0dQbrew19Rqw4xnuWzeu5x754IFPLmCPYFY4zI676vfixzRQ2gIwLgRELh7em84db6yK+mnbKZ5o1aoVTgfykA8eD4P9fIe36yPPVT+EH9NAmScGQuwLDIYCvvF38e3xAz/mLeCqH8oPbaB0kZPkO4dkdNC+wBDPWgw/FIPwQxsos0QmkRyL38QPaqCyfsCAeF6f15fIwdq0tsfbC3OxcJ1X/C/xqTv5/zcoio0v6Sr8VDTnp8YAAAAASUVORK5CYII=',
  'octopus-pink': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAAACXBIWXMAAC4jAAAuIwF4pT92AAABoklEQVRYhWP8//8/w0gGTAwjHDAxjHDAxDDCAQs2QVdRDZSCYffrG4x0cxGd3cCCzeKmyGYGPTkNFDFSHUCJByh1Ayl2sxCyGAQ2lK8m2QHkeoBSN4DUgNTCwKVHN/DqY8ImKFRmhJVNDCDkAWLNIccN6J4HAZA7QO7BZTcTNsF3XeewskkBlAQipW4gxW4mZA4omdQtrwWzf6pIgDEIBHSGEszDoBBGDmVcHiCUCsh1A7F2o9vPCGsJgiSi7WMYbIyDGXjEeRnYhNjB4r/e/WTgffee4dTtMwxt6zqxOgKW7NGTHszx7HdegPMiyGMgdSAalznkuAFmP8x8bHYjAxT7////z+Aiov7/WO4qMIaxv3RfArORaRgbpAcdg8Rhem+3XQOz365/Badh+mF2YNNPrhuQ1YMwsr0gGuQemLnoellgyQ49aYCSHDY+vmQISwWZfYFg9s19BzBSAC4zKHEDsl5wCoCKg+wH8WHugaUSrFkABmAGwSxB5+MD+PI3LHBwJX9K3YCcDdE9iQzQzWCkR28QOWBo2aokxx7Gkd4dBgA5Gc32ukadMQAAAABJRU5ErkJggg==',
  'octopus-green': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAAACXBIWXMAAC4jAAAuIwF4pT92AAABrUlEQVRYhWP8//8/w0gGTAwjHDAxjHDAxDDCAQs2QX5zcZSC4ePJl4x0cxGd3cCCzeKIXi8GZX1lFDFSHUCJByh1Ayl2sxCyGASq9+SS7AByPUCpG0BqQGph4O7Fu3j1MWETrBCqw8omBhDyALHmkOMGdM+DAMgdIPfgspsJm2DHuyasbFIAJYFIqRtIsZsJmQNKJiuKt4HZZj81wBgEWl0mE8zDoBBGDmVcHiCUCsh1A7F2o9vPCGsJgiTMU/QZwuwsGMR4pBn42IXB4p9+vmW4wfea4eLJawxbqvdidQQs2aMnPZjjT7HfAOdFkMdA6kA0LnPIcQPMfpj52OxGBsj2MyEboKgpzVAcN5Nh6/0TYI3+3tlgi0Ghr2+uhTMfw2INFnOmorJgPSAAMgPkGJCj0PMnNk+Q6wYQAMnBPA/SBwIgfSD3wDyOHvgsMA+gGwrzADofXzKEpQKQB0Ds5Te2osQCLICwmUGJG5D1gt2gDxEH2Q/iw9wDSyVYswAMwAyCWYLOxwfw5W9Y4OBK/pS6ATkbonsSGaCbwUiP3iBywNCyVUmOPYwjvTsMALDHXlrNNfZzAAAAAElFTkSuQmCC',
  'octopus-yellow': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAAACXBIWXMAAC4jAAAuIwF4pT92AAABnklEQVRYheVXsUoEMRBNwoKdomBhbSNaaKV+gPgBV1rZWdqcpRZaeo2ViJ8gXCdYXHU22mkhrIW2IoLidlaRl2OO2ZjLbhLcZh8MO8ll8t7MTsKt1FqLNkOJlkOJlkOJliNzTa5szJQuhqf7b9mYooY1ZC7ii15HrK4tluZCBaQkkKohhDurIgbuBgfBAmITSNWANVhLeHx48cYp1+Ts3JHTr4OqBOruE6PBTh6ADuiZxK1ck1+fx04/BClFTNUQwq34AG2y1+0b/+dtyRiwuXVaeYZRYV7lSQlUdUGshrrcNr/iP55fbut+b18Ur/PjBfDRVjeDnT/BPBZtRkbgCeAsAr52jNVA/JyHcxMvWWkPrbVYXp/Wt8NdY+QXxYnx+ZN8xNiGeYrNh4fG/3i+Gj8pnjhc8bEa+HoY58UTemhfOzZDEdBadmXRcq6xrw3pLXS6Z8bP36/NeGohN2+GWtu1R4oGHju6gEfz4MeY9MBIA0HaH0O0EZHYYx9855uKAwF17pNQDfwY2Ely2HvIJr4GeWH+819lDI9s++fwL7q4zYPBQQrHAAAAAElFTkSuQmCC',
  'octopus': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAAACXBIWXMAAC4jAAAuIwF4pT92AAABrElEQVRYhWP8//8/w0gGTAwjHDAxjHDAxDDCAQs2QXEpZ5SC4eWzvYx0cxGd3cCCzeLo0kYGOWVdFDFSHUCJByh1Ayl2sxCyGAQqZ6wj2QHkeoBSN4DUgNTCwKO7l/HqY8ImWBQohpVNDCDkAWLNIccN6J4HAZA7QO7BZTcTNsG+9a+wskkBlAQipW4gxW4mZA4omSztrgezlVV+gzEItGcEEczDoBBGDmVcHiCUCsh1A7F2o9vPCGsJgiQcgqIYjP1sGMQFeRiEuNnB4u++/mR4/5yH4fal0wxrprVjdQQs2aMnPZjj795hBedFkMdA6kA0LnPIcQPMfpj52OxGBsj2MyEbIK2sztCbkMVw8ch9sMYUl3CwxaDQV9UzxZmPYbEGizkJbVGwHhAAmQFyDMhR6PkTmyfIdQMIgORgngfpAwGQPpB7YB5HD3wWmAfQDYV5AJ2PLxnCUgHIAyD2/p03UGIBFkDYzKDEDch6IW6AFMAg+0F8mHtgqQRrFoABmEEwS9D5+AC+/A0LHFzJn1I3IGdDdE8iA3QzGOnRG0QOGFq2Ksmxh3Gkd4cBrxxfsJ6X1cEAAAAASUVORK5CYII=',
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
  'cat2-120': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAABuElEQVR4nO1XsUpDMRTNC0W0hYKgQh11EcFR/AAXFx0Ef6Bz0d1ZxLXiqps/UBH8heImIi7iIioqCK2t4hI5sSeER16atA7K88Club335OZc7strE6WUyDOkyDmkyDuUUpk2MVZUPt9lNpDv8/thWL4P5rzKI/74dkfhk0Y/pAE+fqj4YfjcI8vneQu+Dfbaj6LSrIrR667xY4D88sGKXpcWpwfio37n/D66PsTWr7bF1vyuEU3/5b2b8LuCb5PPm1cxMjsuPuaKYlBAOEEhoUA++PYeP91A6SJOFku6axC/PLVhDsM14y70Hp8W1shncawppN8YM458V/3Qx4C1fU2UaeGw527HjEjjtK43aqzu6zVgx1Pct168TC54mt/jAvYIpoXD7Lirfj9+TAOlLQDjQkDkw9KR6dzayaZo1c6c4olKs1ridCAP+eDxMNjPd3i7PvJc9UP4MQ2UWWIgxL7AYCjgG38X3x4/8GPeAq76ofzQBkoXOUm+c0hGB+0LDPG0xfBDMQw/tIEyTWQSybH4TfygBirrBwyICxc1fYnMHK5ru3y6MxcL11nF/xKfupP/f4Mi3/gCz0T8VCgxpfMAAAAASUVORK5CYII=',
  'cat2-195': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAAByklEQVR4nOVWPUsDQRDdW0Q0Ab9ibGKljY2dQbC1NmV+hFhZWouNYGXrD9Ay4l8QQqwkARux0caPKKJRBFl5y80xHLt7u14R5R4st5Odt7NvMrN3kVJKFBlSFBxSFB1KKeuYmR1XLts0OODvsrOQl+9Ccl7lEL9701N40iDbJwEuvq/4PHzaw2bTeSPbJVipllSt2dbzscGVfn6WlsTdyap4ehhEtqBRFCXBwH+/7Wi7PF/XT/D7jx9WPj8sxed7hPC3OxfioL6S/EY2+KR7xLXJ1/O1GJ1e1MJ/CxLOhfgC/uDzPUJwvP8t+J8A2+sSrFRLOj0Qvz45lxyG5rRuQtw+r5jDn4JjTkKyypjW4W+K79sGvHJsSZRp4Ri8xFu9M71Ra29DzwFTC8Tct3h9grjgaX7MBWwlTL3O103xs/ghCZRcAPUciUS/UeYaO6fi5XzL2f+1ZrtM1QE/+IPn07+850mkKb4PPySB0iYGQqbWDpPDYyCAq/xNfF5+4Ie8BUzxffm+CZSum5zIyCC/wLCeHiF8X+Th+yZQponkRORQ/CW+VwIV+4ABcXnzUl8iC40jPbrd++Riobkt+H/iZ34IFQVy2AcYNn4ATvoJHwPkVVIAAAAASUVORK5CYII=',
  'cat2-270': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAABwUlEQVR4nO1XPUsDQRCdW4KogbPRIpVEGxGilZ2djSD4A/wV2mkvaGf8AbZi2kDAyiqVVgYLGwkWIqhNEr+wWXmbm2U59vb2chbK+WDITnbezL5hbi8JpJRUZAgqOAQVHVLKRJuYDqXLt5kJxLv8NOTlu6DPKx3ij/e7Ep9s7Ps0wMX3FZ+HzzmSfD5vyZWg1hhQq9Km7vit8quNgW9tzT8Ij9R6qbxCNAIf9TtvV9r3BcQebl/Tbn1Zi2b/46Uf8HclV5L7rzuaHZun6ucCjQolPAIL8QXiwTdz/HQDhY04OTOlugbxi2vDZiEJr3nfhujx6WONeC6ONQtJG2PeR7ytvu9jwLVdTRRx4bD3554ekbPmpUq01VxXa8Dcj3Ffo/2QueCBz1zAHMG4cJi5b6ufxs/SQGEKwLgwIHLjcVV37nTznPb6O1bxjFalXebpQBziwePDIJ/r8GZ9xNnq+/CzNFAkiYEQ8wKDoYBr/G18c/zAz/IWsNX35fs2UNjIQTCMYTI6aF5g2I9bFr4v8vB9GyjiRA5iclb8Jr5XA6XxAwbEi1pHXSL1uRNlTzcP+mLhdVLxv8Rn3cH/v0EqNr4BHwX/OTKRLAIAAAAASUVORK5CYII=',
  'frog2-270': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAABzUlEQVR4nOWXPUvDUBSGz71EIQUblaSCnQRBnZROXbrqUhxEcOg/EHUSVHB0dFHE0d1BB+nk2qWjW39BB00rtEJaUImc255wG/PZDx3yQrm5Sd77nPMmTVpm2zYkWRwSLg4JF4eEi0PCxSHhUoIOpgwNA/qW91lmi+HImBgcxX2byH4/bxB/4gGkDG0OAN4vCwX3fjtqEaM0gBwcJ81XAvyi+f3HMtzuFGF5qvdtscwWFccm1UD/HMElYR3Pe9tivahrROFzP/PpyqqApgxNjKjN+ycxDxP5KUAUBogfKcCwNYQXPVQH8qMoDp97mdGoZwyROBpwRNE8Chw1TIDE9+LSfJx8Jj+ACN54M8UcQ8DU1rcOB0xLJ7vQabQHbkFch+DoQ6EXoXLhVITspxpkfj678IuLeihfwXGl4vksicMnv+JehJqn7XyuBPWXGmQ31pzm0ex+C5AQ7qyRMUA/uh5opH8FFj3NEr9af4Xq3TkUcyWHjXX4NT8sn8npH9hfYnt2WoGLT4CzeQ0+mk24Yb2c6DjO3XeAqqfj+LudRlt13z1x+O4QYvq7ltkSfCcAvyv6F/rPf6ScNlQ9HfijKEyqnnauaIRzZ0ZhjVM/00Y1hr1+fYAAAAAASUVORK5CYII=',
  'frog3': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAAACXBIWXMAAAsTAAALEwEAmpwYAAABy0lEQVRYheWXvUvDUBTFbx5BTIpQIUFQcCidBNGtXVydqrg5O7hYcJMKzp06V3DyL9BBnBydKi6Cq5PgIK0iSNMuEjmvvfE1JmnSDx1yoLyP5Lzfvfe9Jq3mui6lWYJSLkEpl6CUS1DKJSjl0qMumhkbBfpS55x2U0OrabLxlPRtovrDvFH8qRfAzNjzRPS+Vyv45924QYyTADhop83XI/wy+frBNZVPS5TN974tTrvJwWnTSqB/j+SyEMfJzbZcL+4acfgizLxVyUmombFlC1U3r+R4mNjPBYRQQHyUAg5bQ3rh4TjAj6MkfBFkhtGybFlxGNBCPI4Dh0YpIPODuDyeJF9TH0AMb7V6SaIIqNr+2s6AaSVXoY7TGjiCWIfh8EHwAqoGzkGofo5B5eeLC7+4UO3iks6P7gKfJUn47Nf9i3Dy3N8tFuj55YGWl9a95GH2vwVYgP+sYdOtdTiQSH8HFgPNCv+p8UqVxhmVSwWPjTjCkh+Vr6nVXy07sj+b1em+OkMbxwZ9fL7RY92U83wdY/8JMEwrib/bcVqG//Qk4fuLkNDfddpNyfcKELajf6H//EcquGOYVuSPomEyTMvb0Rj3zo3DmqS+Aaa7NqYBW1vuAAAAAElFTkSuQmCC'
};

// ── SpriteRenderer ─────────────────────────────────────────
// CSS background-image + RAF. No canvas. No image load events.
// Sheet 64x16 displayed at 128x32 (2x). backgroundPosition shifts per frame.

const ANIMALS = ['cat2', 'snake', 'penguin', 'octopus-pink', 'crab', 'rat', 'seal', 'rabbit', 'cat', 'frog3', 'octopus', 'octopus-yellow', 'octopus-green', 'cat-120', 'rabbit-120', 'penguin-120', 'crab-120', 'rat-120', 'seal-120', 'snake-120', 'cat2-120', 'cat-195', 'rabbit-195', 'penguin-195', 'crab-195', 'rat-195', 'seal-195', 'snake-195', 'cat2-195', 'cat-270', 'rabbit-270', 'penguin-270', 'crab-270', 'rat-270', 'seal-270', 'snake-270', 'cat2-270'];
const IDENTITY_SEQ_KEY = 'pixel-terminal-identity-seq-v9';
// First BASE_ANIMAL_COUNT entries in ANIMALS are 0-degree originals; rest are hue-rotated.
// Only octopus-pink represents octopus in the base set — octopus/yellow/green cycle in the hue batch.
const BASE_ANIMAL_COUNT = 10;

function _shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getNextIdentity() {
  // Each full cycle: all BASE_ANIMAL_COUNT original-color animals (shuffled) come first,
  // then all hue-rotated animals (shuffled). Regenerates on first run and after exhaustion.
  const store = JSON.parse(localStorage.getItem(IDENTITY_SEQ_KEY) || '{"idx":0,"seq":null}');

  if (!store.seq || store.idx >= ANIMALS.length) {
    const base = _shuffle(Array.from({ length: BASE_ANIMAL_COUNT }, (_, i) => i));
    const hue  = _shuffle(Array.from({ length: ANIMALS.length - BASE_ANIMAL_COUNT }, (_, i) => BASE_ANIMAL_COUNT + i));
    store.seq = [...base, ...hue];
    store.idx = 0;
  }

  const animalIndex = store.seq[store.idx];
  store.idx++;
  localStorage.setItem(IDENTITY_SEQ_KEY, JSON.stringify(store));
  return { animalIndex };
}

// Per-sprite X offset (3x px) to horizontally center each character within the 48px frame.
// Derived from: round(24 - vis_center_px) where vis_center_px = (left_col + right_col) / 2 × 3.
// Positive X shifts the background right, moving the character toward horizontal center.
// Hue variants share geometry with their base animal.
const SPRITE_X_OFFSETS = {
  // 0px — rat is already centered (vis_center = 8.0)
  'rat':0,'rat-120':0,'rat-195':0,'rat-270':0,
  // 2px — cat, cat2, snake, penguin, crab, frog3 (vis_center ≈ 7.5)
  'cat':2,'cat2':2,'snake':2,'penguin':2,'crab':2,'frog3':2,
  'cat-120':2,'cat2-120':2,'snake-120':2,'penguin-120':2,'crab-120':2,
  'cat-195':2,'cat2-195':2,'snake-195':2,'penguin-195':2,'crab-195':2,
  'cat-270':2,'cat2-270':2,'snake-270':2,'penguin-270':2,'crab-270':2,
  // 3px — rabbit, seal (vis_center = 7.0)
  'rabbit':3,'seal':3,
  'rabbit-120':3,'seal-120':3,
  'rabbit-195':3,'seal-195':3,
  'rabbit-270':3,'seal-270':3,
  // 5px — all octopi (vis_center = 6.5)
  'octopus':5,'octopus-pink':5,'octopus-green':5,'octopus-yellow':5,
};

// Per-sprite Y offset (3x px) to bottom-align all characters on the same baseline.
// Derived from: (13 - sprite_bot_row) × 3  where 13 is the deepest bottom row across all sprites.
// Positive Y shifts the background image down, moving the character lower in the container.
const SPRITE_Y_OFFSETS = {
  // bot=13 → 0px (reference baseline)
  'cat':0,'cat2':0,'snake':0,'frog3':0,
  'octopus':0,'octopus-pink':0,'octopus-green':0,'octopus-yellow':0,
  'cat-120':0,'cat2-120':0,'snake-120':0,
  'cat-195':0,'cat2-195':0,'snake-195':0,
  'cat-270':0,'cat2-270':0,'snake-270':0,
  'penguin-270':0,
  // bot=12 → 3px
  'rabbit':3,'penguin':3,'rat':3,'seal':3,
  'rabbit-120':3,'penguin-120':3,'rat-120':3,'seal-120':3,
  'rabbit-195':3,'penguin-195':3,'rat-195':3,'seal-195':3,
  'rabbit-270':3,'rat-270':3,'seal-270':3,
  // bot=11 → 6px
  'crab':6,'crab-120':6,'crab-195':6,'crab-270':6,
};

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
    this._xOffset = SPRITE_X_OFFSETS[animal] ?? 0;
    this._yPx = (SPRITE_Y_OFFSETS[animal] ?? 0) + 'px';

    el.style.width = '48px';
    el.style.height = '48px';
    el.style.flexShrink = '0';
    el.style.backgroundImage = "url('" + data + "')";
    el.style.backgroundSize = '192px 48px';
    el.style.backgroundRepeat = 'no-repeat';
    el.style.backgroundPosition = this._xOffset + 'px ' + this._yPx;
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
    this.el.style.backgroundPosition = this._xOffset + 'px ' + this._yPx; // snap to frame 0 immediately
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
        this.el.style.backgroundPosition = ((-this._frameIdx * 48) + this._xOffset) + 'px ' + this._yPx;
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


function formatTokens(n) {
  const t = n || 0;
  if (t < 1_000_000) return Math.round(t / 1000) + 'K';
  return (t / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}

// ── Exports ────────────────────────────────────────────────
export { SPRITE_DATA, ANIMALS, SpriteRenderer, IDENTITY_SEQ_KEY, getNextIdentity };
export { sessions, sessionLogs, spriteRenderers, syncOmiSessions };
export { isSelfDirectory, formatTokens };

// activeSessionId as getter/setter — ES modules cannot export mutable let bindings
export function getActiveSessionId() { return activeSessionId; }
export function setActiveSessionId(id) { activeSessionId = id; }
