import {describe,it,expect} from 'vitest';
import {rank,label,red,sortCards} from './cards';
describe('physical card protocol',()=>{
 it('maps all 54 cards to the Go protocol ranks',()=>{const groups=new Map<number,number>();for(let i=0;i<54;i++)groups.set(rank(i),(groups.get(rank(i))??0)+1);expect([...groups.values()]).toEqual([...Array(13).fill(4),1,1]);expect(label(48)).toBe('2');expect(label(52)).toBe('小王');expect(label(53)).toBe('大王');});
 it('keeps red suits and ordered kings consistent',()=>{expect(red(1)).toBe(true);expect(red(2)).toBe(false);expect(red(53)).toBe(true);expect(sortCards([0,53,48,52,44])).toEqual([53,52,48,44,0]);});
});
