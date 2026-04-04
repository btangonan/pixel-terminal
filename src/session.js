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
  'octopus': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAABrElEQVR4nGP8//8/w0gGTAwjHDAxjHDAxDDCAQu6gLiUM9ZC4eWzvYx0cRGd3cCCbnF0aSOYLaesCxd/dPcyWI5YB1DiAVxugMkRMoNUu1mwCaJbjM6npQfIsRPZ/MoZ61DEQJGHz24mbAYVBYphZZMCyPEAtd1AjDuYsAn2rX+FlU1PD1DiBlLsZkLmgJLI0u56MFtZ5TcYg0B7RhDB/AtKYsj5D5cHcOVRSt1ArN3o9jPCWoIgCYegKAZjPxsGcUEeBiFudrD4u68/Gd4/52G4fek0w5pp7VgdgZzvkZMezPF377CC8yLIYyB1IBqXOeS4AWY/zHxsdiMDZPuZkA2QVlZn6E3IYrh45D5YY4pLONhiUOir6pkygAoYbDEIizVYzEloi4L1gADIDJBjQI5CL6CweYJcN4AASA7meZA+EADpA7kH5nH0wGeBeQDdUJgH0Pn4kiEsFYA8AGLv33kDJRZgAYTNDErcgKwX4gZIwQeyH8SHuQeWSrBmARiAGQSzBJ2PD+DL37DAwZX8KXUDcjZE9yQyQDeDkR69QeSAoWWLkhx7GEd6dxgAM5ZFvsfDJAIAAAAASUVORK5CYII=',
  'octopus-90': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAABn0lEQVR4nGP8//8/w0gGTAwjHDAxjHDAxDDCAQu6gLOYAdZCYe+rC4x0cRGd3cCCbnFjdDuYrSuvDRe//PAqWI5YB1DiAVxugMkRMoNUu1mwCaJbjM6npQfIsRPZ/HVVm1DEQJGHz24mbAaJFSpjZZMCyPEAtd1AjDuYsAm+6r+LlU1PD1DiBlLsZkLmgJJI/dJKMPuLMhcYg0BQmx/B/AtKYsj5D5cHcOVRSt1ArN3o9jPCWoIgiSjHeAZjYy8GXnEeBg4hdrD4j3c/GUTe/2U4ffsUQ/vqFqyOQM73yEkP5nieu9/AeRHkMZA6EI3LHHLcALMfZj42u5EBiv3///9ncBLV/3+4YBsYw9gf+h+C2cg0jA3Sg45B4jC95ztvgNlPNr2G0zD9MDuw6SfXDcjqQRjZXhANcg/MXHS9LLBkh540QEkOGx9fMoSlguKecDD7/r7TGCkAlxmUuAFZLzgFMEAKPpD9ID7MPbBUgjULwADMIJgl6Hx8AF/+hgUOruRPqRuQsyG6J5EBuhmM9OgNIgcMLVuU5NjDONK7wwBkI7UHh2kUZAAAAABJRU5ErkJggg==',
  'octopus-180': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAABq0lEQVR4nGP8//8/w0gGTAwjHDAxjHDAxDDCAQu6gLODGNZCYe+BV4x0cRGd3cCCbnFjejSYrashDxe/fOMhWI5YB1DiAVxugMkRMoNUu1mwCaJbjM6npQfIsRPZ/HX9VShioMjDZzcTNoPEzAqxskkB5HiA2m4gxh1M2ARfnerHyqanByhxAyl2MyFzQEmkfuZSMPv3L2UwBoGgwjaC+ReUxJDzHy4P4MqjlLqBWLvR7WeEtQRBElEejgw2isYMPELiDOx8QmDxn5/eMfCIvGc4ffk2Q/u81VgdgZzvkZMezPGsbHfBeRHkMZA6EI3LHHLcALMfZj42u5EBsv1MyAaoy0sxZE3vYbj/5gJYY3h5MthiUOib6qoygAoYbDEIizVYzIkySYL1gADIDJBjQI5CL6CweYJcN4AASA7meZA+EADpA7kH5nH0wGeBeQDdUJgH0Pn4kiEsFYA8AGLfuLcPJRZgAYTNDErcgKwXkgIg4iD7QXyYe2CpBGsWgAGYQTBL0Pn4AL78DQscXMmfUjcgZ0N0TyIDdDMY6dEbRA4YWrYoybGHcaR3hwH0ckd97in7ugAAAABJRU5ErkJggg==',
  'octopus-270': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAABrElEQVR4nGP8//8/w0gGTAwjHDAxjHDAxDDCAQu6gJizJtZC4dXe64x0cRGd3cCCbnF0YyiYLa+rABd/ePkBWI5YB1DiAVxugMkRMoNUu1mwCaJbjM6npQfIsRPZ/Kp1pShioMjDZzcTNoMKxVKxskkB5HiA2m4gxh1M2AT7X83GyqanByhxAyl2MyFzQElkaf1qMFvztygYg0BbUDfB/AtKYsj5D5cHcOVRSt1ArN3o9jPCWoIgCccoGwZrG1UGMR5xBkF2IbD4+5/vGF7w/GW4ffoOw+r29VgdgZzvkZMezPHXWV+D8yLIYyB1IBqXOeS4AWY/zHxsdiMDZPuZkA2QUpdkaMmaz3Dy/l2wxtjwMrDFoNBXNVVhABUw2GIQFmuwmFMU5QHrAQGQGSDHgByFXkBh8wS5bgABkBzM8yB9IADSB3IPzOPogc8C8wC6oTAPoPPxJUNYKgB5AMTeceM0SizAAgibGZS4AVkv2A26EHGQ/SA+zD2wVII1C8AAzCCYJeh8fABf/oYFDq7kT6kbkLMhuieRAboZjPToDSIHDC1blOTYwzjSu8MAVB5HqdkK8JkAAAAASUVORK5CYII=',
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
  'frog3': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAAACXBIWXMAAAsTAAALEwEAmpwYAAABy0lEQVRYheWXvUvDUBTFbx5BTIpQIUFQcCidBNGtXVydqrg5O7hYcJMKzp06V3DyL9BBnBydKi6Cq5PgIK0iSNMuEjmvvfE1JmnSDx1yoLyP5Lzfvfe9Jq3mui6lWYJSLkEpl6CUS1DKJSjl0qMumhkbBfpS55x2U0OrabLxlPRtovrDvFH8qRfAzNjzRPS+Vyv45924QYyTADhop83XI/wy+frBNZVPS5TN974tTrvJwWnTSqB/j+SyEMfJzbZcL+4acfgizLxVyUmombFlC1U3r+R4mNjPBYRQQHyUAg5bQ3rh4TjAj6MkfBFkhtGybFlxGNBCPI4Dh0YpIPODuDyeJF9TH0AMb7V6SaIIqNr+2s6AaSVXoY7TGjiCWIfh8EHwAqoGzkGofo5B5eeLC7+4UO3iks6P7gKfJUn47Nf9i3Dy3N8tFuj55YGWl9a95GH2vwVYgP+sYdOtdTiQSH8HFgPNCv+p8UqVxhmVSwWPjTjCkh+Vr6nVXy07sj+b1em+OkMbxwZ9fL7RY92U83wdY/8JMEwrib/bcVqG//Qk4fuLkNDfddpNyfcKELajf6H//EcquGOYVuSPomEyTMvb0Rj3zo3DmqS+Aaa7NqYBW1vuAAAAAElFTkSuQmCC',
  'k-whale-half5': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACQAAAAKCAYAAADcpvzeAAAACXBIWXMAAAsTAAALEwEAmpwYAAABgUlEQVQ4jYVUwU7DMAxN2o5NQhw3reMCf+Bv2GFS6Klf2lNVqYf9QvIHnNCk3bgApS1BDnXxomR7kpc6sd9enMTSWitCMMZIALB8FEKgWeYjEgAYgyQTD8aoohxOb6+UEwcK0lpLHLnhnNY63e6eLPo4kmmtE+77uSxfUux6vQ3GkRGPExLYEUKqohzH/kuczydpjMlUUfboE9LFSjR1lQLAT4jjRSk5jGKuHvKEipI/PjsRWMELQbeIjDELVZTfKGoScw8AH5x8l+fSJqtZYPf5Pq9l2dLlIYiDAwVlQaJkJYbun2izya1PFLoPxMFFcAxD54zEhZD4RGQ+Ucfmm7paesf7FzeKCzHH49FZDE1dJf7GMiLiFSGS/X4f4+rxB19b9N8i+VSZtm3wdc53h+6Ru0N4JFTKGLIAkY+pYrizB5pTRTmvN3VFn3cA4DblwwkKER0Oag5q2+YmkScM+457FPgK6RsrQcfMN0W9zjnXekOor1yb5+vUf2g+1q98+wV7FqD/eigC7wAAAABJRU5ErkJggg==',
  'k-whale2': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAAACXBIWXMAAAsTAAALEwEAmpwYAAACUElEQVRYhcVXvW7jMAymFCfN3SFjC8dTHkHPkMGAmilPmikw4CGvYL3BTYcC3Q4Zrmls60BXdAlX/inyYwIEZUHkR1KSSQlrLXSRMUagVEp1L7wRXQvfGOOdF30J6DEq+hy7ZQK/gw8A3nXBQGUkHFsEZPMSAIouG10O9gVwTfy2ExD0OYdSb7YlzSf73URvtjXoy5/foi+AtiCHJOeW+AAgpCfT3ACClcl+N8Xv4vwGcawLlORMXwA0NsZIwnHfyJN74bvTQjgoP+bwH8A5yzLhWIbRyj4+htbNB/SNMsuyH1ynxc4E13Imu8Rj4wv+E6SdeNZa5MXn3Xp9fal2DACmcaxPaZr8BIA339Fiu4lHt9qtNE2merM9084hTabzageVUuWY+AFNRMulsHL+4YycQ376Wy9+elpaVGDUCd4MQCmVJ/vdTG+27+iEA//Fgx8DHwDKgIOf/n2CcsrzU8VIQfCAAu/kO79n3wkg2e8kD2AMfCqLASrmBZRc4XA4VHK9XnsdAoCzy6y9NIBnrWEsfAAQ1T8AM0QL2sgp4n36sntVAEy/KwC007QxBj6dAIEJcHcH07eghXGsa6U0TWg4U0pV2ed0SQBI98bnXaFoVAFJTQZvOLDZ8DUVvFlpBnA8Hmu7i8WiM4B74tP1qck26ijVSTee+Wp1G6MuyjBaUR0XYbSSvL43a/W18cNo9cDwsQ+oMRwDY/HlMUTdGZaIZsYHdl14xMuhjxWPrUvx28ZeXYEdlgPDhUOcbT5Q6lruyBtAmwPuPXIz/D6b/wEwuXBB+7CyJwAAAABJRU5ErkJggg==',
  // ── Companion sprites (species-keyed for buddy system) ──────────────────────
  'dragon': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAYAAACm53kpAAAA0klEQVR4nO2V0Q2EIAyGu8IlTMAsDucsTnIPN8SN4AY964mHgm0RTQSvCQm0/f7SJiLA35b26izuidXCAzYWuwcEieSjWNW8S+JWTLwK3of7/onGmPlMe/JxIkfy+G6+y7+85zujvmp66gYK5H8CbtKxpblAoXw4xRTwavzA+Lmjn/l8ti+hfHyuytN+fWZhbIfE1gbQuJ9iEivxGo099bP5GKwV2Wo+ZQg59bN5DpZEpOY1Q8ipfwQ/m/QrSXrECuQXImu/VqB0HtzLqfXXxt/OPvLnWmPWtvjRAAAAAElFTkSuQmCC'
};

const IDENTITY_SEQ_KEY = 'pixel-terminal-identity-seq-v11'; // kept for app.js localStorage cleanup

// ── Familiar roll algorithm (per-project ASCII buddy) ────────────────────────
// Deterministic: same projectPath always produces same species/rarity/eye/hat/stats.
// Bones are never stored — recomputed on every session create from path hash.

function _fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function _mulberry32(seed) {
  let a = seed >>> 0;
  return function() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FAMILIAR_SALT = 'pixel-familiar-2026';

// Syllable pools — five thematic categories (Asian Folklore, Polynesian, Tolkien/Elven, Valyrian, Cyber-Pet)
const _NAME_STARTS = [
  // Asian Folklore & Yokai
  'Ryu', 'Sen', 'Kai', 'Jin', 'Feng', 'Qin', 'Bai', 'Shir', 'Zen', 'Tao',
  // Polynesian
  'Ka', 'Ki', 'Ma', 'Wa', 'Ra', 'Ori', 'Alo', 'Koa', 'Lani', 'Mana', 'Nalu',
  // Tolkien / Elven
  'Aer', 'Cal', 'Gil', 'Lin', 'Sil', 'Thal', 'Fin',
  'Ael', 'Aran', 'Cael', 'Elan', 'Faer', 'Helm', 'Saer', 'Bael',
  // Valyrian
  'Drac', 'Vae', 'Tar', 'Rys', 'Jae', 'Zho', 'Laen',
  'Aeg', 'Daen', 'Nar', 'Tor',
  // Cyber-Pet
  'Zot', 'Blip', 'Xel', 'Hex', 'Rez', 'Vox', 'Nyx',
  'Arc', 'Chip', 'Flux', 'Kern', 'Var', 'Sig', 'Rad',
];
const _NAME_ENDS = [
  // Asian Folklore
  'on', 'rin', 'kin', 'gu', 'yu', 'zen',
  // Polynesian
  'kai', 'mai', 'aia', 'lua', 'alo', 'ana', 'ila', 'ali',
  // Tolkien / Elven
  'wen', 'dal', 'dor', 'en', 'shan', 'aen', 'ion', 'ros', 'mir', 'las', 'ael',
  // Valyrian
  'rys', 'orn', 'oz', 'ur', 'ys',
  // Cyber-Pet
  'ron', 'bit', 'rom', 'arc', 'ware',
];
// Hard blocks — real-world IP, known words, or sounds bad
const _NAME_BLOCKLIST = new Set(['Finbit', 'Aegon', 'Radon', 'Torys']);

export const FAMILIAR_SPECIES = [
  'duck', 'goose', 'blob', 'cat', 'dragon', 'octopus', 'owl',
  'penguin', 'turtle', 'snail', 'ghost', 'axolotl', 'capybara',
  'cactus', 'robot', 'rabbit', 'mushroom', 'chonk',
];
const _FAMILIAR_EYE_STYLES  = ['dot', 'star', 'x', 'circle', 'at', 'degree'];
const _FAMILIAR_HATS        = ['none', 'crown', 'tophat', 'propeller', 'halo', 'wizard', 'beanie', 'tinyduck'];
const _FAMILIAR_STAT_NAMES  = ['DEBUGGING', 'PATIENCE', 'CHAOS', 'WISDOM', 'SNARK'];
const _FAMILIAR_EYE_CHARS   = { dot: '·', star: '✦', x: '×', circle: '◉', at: '@', degree: '°' };
// Stat bands: dumpMax < midMin < midMax < peakMin — no tier bleed, no range overlap.
const _FAMILIAR_RARITIES = [
  { name: 'common',    weight: 60, midMin: 10, midMax: 40,  peakMin: 55,  peakMax: 84,  dumpMin: 1,  dumpMax: 9  },
  { name: 'uncommon',  weight: 25, midMin: 20, midMax: 55,  peakMin: 65,  peakMax: 94,  dumpMin: 10, dumpMax: 19 },
  { name: 'rare',      weight: 10, midMin: 30, midMax: 65,  peakMin: 75,  peakMax: 100, dumpMin: 20, dumpMax: 29 },
  { name: 'epic',      weight: 4,  midMin: 40, midMax: 74,  peakMin: 85,  peakMax: 100, dumpMin: 30, dumpMax: 39 },
  { name: 'legendary', weight: 1,  midMin: 55, midMax: 84,  peakMin: 100, peakMax: 100, dumpMin: 40, dumpMax: 50 },
];

// ── Re-roll helpers ──────────────────────────────────────────
export function getFamiliarRerollCount(projectPath) {
  return parseInt(localStorage.getItem(`familiar-reroll-${projectPath}`) || '0', 10);
}
export function incrementFamiliarReroll(projectPath) {
  const count = getFamiliarRerollCount(projectPath) + 1;
  localStorage.setItem(`familiar-reroll-${projectPath}`, String(count));
  return count;
}

export function rollFamiliarBones(projectPath, rerollCount = 0) {
  const base  = projectPath || ('__anon-' + Math.random().toString(36).slice(2));
  const input = rerollCount > 0 ? `${base}-r${rerollCount}` : base;
  const seed  = _fnv1a(input + FAMILIAR_SALT);
  const rng   = _mulberry32(seed);

  // Roll 1: Rarity (weighted)
  const rarityRoll = rng() * 100;
  let cumul = 0, rarity = _FAMILIAR_RARITIES[0];
  for (const r of _FAMILIAR_RARITIES) { cumul += r.weight; if (rarityRoll < cumul) { rarity = r; break; } }

  // Roll 2: Species (uniform)
  const species = FAMILIAR_SPECIES[Math.floor(rng() * FAMILIAR_SPECIES.length)];

  // Roll 3: Eye (uniform)
  const eyeStyle = _FAMILIAR_EYE_STYLES[Math.floor(rng() * _FAMILIAR_EYE_STYLES.length)];
  const eye = _FAMILIAR_EYE_CHARS[eyeStyle] ?? '·';

  // Roll 4: Hat (common always 'none'; others uniform across all 8)
  let hat = 'none';
  if (rarity.name !== 'common') hat = _FAMILIAR_HATS[Math.floor(rng() * _FAMILIAR_HATS.length)];

  // Roll 5: Shiny (1% independent)
  const shiny = rng() < 0.01;

  // Rolls 6-10: Stats — peak, dump, 3 mid values
  const peakIdx = Math.floor(rng() * 5);
  const dumpRaw = Math.floor(rng() * 4);
  const dumpIdx = dumpRaw >= peakIdx ? dumpRaw + 1 : dumpRaw;
  const { midMin, midMax, peakMin, peakMax, dumpMin, dumpMax } = rarity;
  const stats = {};
  for (let i = 0; i < 5; i++) {
    let v;
    if      (i === peakIdx) { v = peakMin === peakMax ? peakMax : Math.floor(rng() * (peakMax - peakMin + 1)) + peakMin; }
    else if (i === dumpIdx) { v = Math.floor(rng() * (dumpMax - dumpMin + 1)) + dumpMin; }
    else                    { v = Math.floor(rng() * (midMax - midMin + 1)) + midMin; }
    stats[_FAMILIAR_STAT_NAMES[i]] = v;
  }

  // Roll N+1, N+2: Name (syllable combiner — deterministic, runs after stats to preserve existing stat RNG)
  const nameStart = _NAME_STARTS[Math.floor(rng() * _NAME_STARTS.length)];
  const endBase   = Math.floor(rng() * _NAME_ENDS.length);
  let name = nameStart + _NAME_ENDS[endBase];
  // Rotate through remaining ends if blocklisted — no extra rng() calls, stays deterministic
  for (let i = 1; i < _NAME_ENDS.length && _NAME_BLOCKLIST.has(name); i++) {
    name = nameStart + _NAME_ENDS[(endBase + i) % _NAME_ENDS.length];
  }

  return { species, rarity: rarity.name, eye, hat, shiny, stats, name };
}

// ── Per-project hue assignment (ephemeral — resets on restart) ───────────────
// Same project opened N times gets the Nth hue from the palette.

const FAMILIAR_HUE_PALETTE = ['#FFDD44', '#FF8C42', '#40E0D0', '#FF6EC7'];
const _projectSlots = new Map(); // projectPath → sessionId[]

export function assignFamiliarHue(projectPath, sessionId) {
  if (!_projectSlots.has(projectPath)) _projectSlots.set(projectPath, []);
  const slots = _projectSlots.get(projectPath);
  const hue = FAMILIAR_HUE_PALETTE[slots.length % FAMILIAR_HUE_PALETTE.length];
  slots.push(sessionId);
  return hue;
}

export function releaseFamiliarHue(projectPath, sessionId) {
  if (!_projectSlots.has(projectPath)) return;
  const slots = _projectSlots.get(projectPath);
  const idx = slots.indexOf(sessionId);
  if (idx >= 0) slots.splice(idx, 1);
  if (slots.length === 0) _projectSlots.delete(projectPath);
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
export { SPRITE_DATA, IDENTITY_SEQ_KEY };
export { sessions, sessionLogs, syncOmiSessions };
export { FAMILIAR_HUE_PALETTE };
export { isSelfDirectory, formatTokens };

// activeSessionId as getter/setter — ES modules cannot export mutable let bindings
export function getActiveSessionId() { return activeSessionId; }
export function setActiveSessionId(id) { activeSessionId = id; }
