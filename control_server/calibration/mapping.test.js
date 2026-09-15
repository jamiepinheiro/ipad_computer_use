'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {displacement,chooseMove}=require('./mapping');
const curve=[{input:1,output:.2},{input:8,output:6},{input:40,output:56},{input:80,output:144}];
test('curve interpolation and integer inverse preserve direction and bounded reports',()=>{
 assert.equal(displacement(0,curve),0);
 assert.equal(displacement(80,curve),144);
 assert.equal(displacement(60,curve),100);
 for(const [x,y] of [[100,0],[0,-100],[12,6],[-500,-400],[.5,.5]]){
  const m=chooseMove(x,y,curve);
  assert(Number.isInteger(m.dx)&&Number.isInteger(m.dy));
  assert(Math.hypot(m.dx,m.dy)<=81);
  assert(Math.hypot(x-m.px,y-m.py)<Math.hypot(x,y));
 }
 assert.deepEqual(chooseMove(0,0,curve),{dx:0,dy:0,px:0,py:0});
});
