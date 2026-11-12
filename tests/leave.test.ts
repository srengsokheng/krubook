import { describe, expect, it } from 'vitest';
import { leaveMessage, time12, timeRanges } from '../shared/leave.ts';

describe('leave request message', () => {
  it('writes the message in the teacher’s format', () => {
    expect(leaveMessage({
      name: 'Sreng Sokheng', date: '2026-11-13', reason: 'ខ្ញុំមានការប្រឡងថ្នាក់អនុបណ្ឌិត (Master)',
      classes: [{ code: 'SBQ3', start: '16:15', end: '17:15' }, { code: 'SY14', start: '14:45', end: '16:15' }],
    })).toBe('ជម្រាបសួរលោកគ្រូ ខ្ញុំសូមអនុញ្ញាតច្បាប់\nSRENG SOKHENG FRI 13-11-2026 (2:45 PM - 5:15 PM ONLY)\nដោយសារខ្ញុំមានការប្រឡងថ្នាក់អនុបណ្ឌិត (Master)។ សូមអរគុណ ។');
  });

  it('keeps separate ranges for classes with a break between them, and fills a custom template', () => {
    expect(timeRanges([{ start: '16:15', end: '17:15' }, { start: '13:00', end: '14:30' }])).toEqual([{ start: '13:00', end: '14:30' }, { start: '16:15', end: '17:15' }]);
    expect(leaveMessage({
      template: '{name} · {day} {date} · {times} · {classes} · {reason}', name: 'a b', date: '2026-11-21', reason: 'ខ្ញុំមិនស្រួលខ្លួន ។ ',
      classes: [{ code: 'SY9', start: '08:45', end: '10:15' }, { code: 'SY11', start: '10:15', end: '11:45' }, { code: 'SY33', start: '13:00', end: '14:30' }],
    })).toBe('A B · SAT 21-11-2026 · 8:45 AM - 11:45 AM, 1:00 PM - 2:30 PM · SY9, SY11, SY33 · ខ្ញុំមិនស្រួលខ្លួន');
    expect([time12('07:00'), time12('12:00'), time12('00:30'), time12('19:45')]).toEqual(['7:00 AM', '12:00 PM', '12:30 AM', '7:45 PM']);
  });
});
