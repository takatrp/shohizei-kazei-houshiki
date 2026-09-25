(function(root, factory){
  const api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  root.ShohizeiTaxCalendar = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';

  // Cabinet Office published holiday lists checked 2026-09-25. Later years use
  // current statutory rules only; equinoxes and exceptional holidays are not official.
  const VERSION = 'cabinet-2026-2027-r1';
  const OFFICIAL = {
    2026: ['01-01','01-12','02-11','02-23','03-20','04-29','05-03','05-04','05-05','05-06','07-20','08-11','09-21','09-22','09-23','10-12','11-03','11-23'],
    2027: ['01-01','01-11','02-11','02-23','03-21','03-22','04-29','05-03','05-04','05-05','07-19','08-11','09-20','09-23','10-11','11-03','11-23']
  };
  const predictedCache = new Map();

  function utcDate(year, month, day){
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(0, 0, 0, 0);
    return date;
  }
  function formatDate(date){
    return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  }
  function parseDate(value){
    if(typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(value)) return null;
    const year = Number(value.slice(0,4)), month = Number(value.slice(5,7)), day = Number(value.slice(8,10));
    if(year < 1900 || year > 2200) return null;
    const date = utcDate(year, month, day);
    return formatDate(date) === value ? date : null;
  }
  function daysInMonth(year, month){ return utcDate(year, month + 1, 0).getUTCDate(); }
  function shiftDays(value, days){
    const date = parseDate(value);
    if(!date || !Number.isSafeInteger(days) || Math.abs(days) > 3660) return null;
    date.setUTCDate(date.getUTCDate() + days);
    return formatDate(date);
  }
  function shiftMonths(value, months){
    const date = parseDate(value);
    if(!date || !Number.isSafeInteger(months) || Math.abs(months) > 120) return null;
    const targetYear = date.getUTCFullYear(), targetMonth = date.getUTCMonth() + months;
    const start = utcDate(targetYear, targetMonth + 1, 1);
    const maxDay = daysInMonth(start.getUTCFullYear(), start.getUTCMonth() + 1);
    start.setUTCDate(Math.min(date.getUTCDate(), maxDay));
    return formatDate(start);
  }
  function periodEnd(start, months){
    const next = shiftMonths(start, months);
    return next ? shiftDays(next, -1) : null;
  }
  function priorMonths(start, end){
    const first = parseDate(start), last = parseDate(end);
    if(!first || !last || first > last) return null;
    // 29/30/31-day mid-month starts require a statutory period-by-period
    // determination when a shorter month intervenes; do not infer by days/30.
    if(first.getUTCDate() > 28 && first.getUTCDate() !== 1) return null;
    for(let months = 1; months <= 12; months++) if(periodEnd(start, months) === end) return months;
    return null;
  }
  function deadlineFromStart(start, monthsUntilClockStart){
    const clockStart = shiftMonths(start, monthsUntilClockStart);
    return clockStart ? periodEnd(clockStart, 2) : null;
  }
  function deadlineAfterPeriod(end){
    const nextDay = shiftDays(end, 1);
    return nextDay ? periodEnd(nextDay, 2) : null;
  }
  function nthMonday(year, month, n){
    const first = utcDate(year, month, 1).getUTCDay();
    return 1 + ((8 - first) % 7) + 7 * (n - 1);
  }
  function predictedEquinox(year, spring){
    // Current statutory-rule projection, not a published equinox date.
    return Math.floor((spring ? 20.8431 : 23.2488) + (year - 1980) * 0.242194 - Math.floor((year - 1980) / 4));
  }
  function predictedHolidaySet(year){
    if(predictedCache.has(year)) return predictedCache.get(year);
    const days = new Set();
    function add(month, day){ days.add(`${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`); }
    [[1,1],[2,11],[2,23],[4,29],[5,3],[5,4],[5,5],[8,11],[11,3],[11,23]].forEach(([m,d]) => add(m,d));
    add(1,nthMonday(year,1,2)); add(7,nthMonday(year,7,3));
    add(9,nthMonday(year,9,3)); add(10,nthMonday(year,10,2));
    add(3,predictedEquinox(year,true)); add(9,predictedEquinox(year,false));
    // Substitute holidays and the day between two statutory holidays.
    const statutory = [...days];
    for(const md of statutory){
      const date = parseDate(`${year}-${md}`);
      if(date.getUTCDay() !== 0) continue;
      let next = shiftDays(formatDate(date),1);
      while(next.startsWith(`${year}-`) && days.has(next.slice(5))) next = shiftDays(next,1);
      if(next.startsWith(`${year}-`)) days.add(next.slice(5));
    }
    for(let day = utcDate(year,1,2); day.getUTCFullYear() === year; day.setUTCDate(day.getUTCDate()+1)){
      const key = formatDate(day).slice(5);
      if(days.has(key)) continue;
      const prior = shiftDays(formatDate(day),-1), next = shiftDays(formatDate(day),1);
      if(prior.startsWith(`${year}-`) && next.startsWith(`${year}-`) && statutory.includes(prior.slice(5)) && statutory.includes(next.slice(5))) days.add(key);
    }
    predictedCache.set(year, days);
    return days;
  }
  function holidayInfo(value){
    const date = parseDate(value);
    if(!date) return null;
    const year = date.getUTCFullYear(), month = date.getUTCMonth()+1, day = date.getUTCDate();
    const official = Object.prototype.hasOwnProperty.call(OFFICIAL, year);
    if(!official && (year < 2000 || year > 2099)) return {closed:null,reasons:['休日計算の対応年外です。'],confidence:'unknown'};
    const reasons = [];
    if(date.getUTCDay() === 0 || date.getUTCDay() === 6) reasons.push('土日');
    if((month === 12 && day >= 29) || (month === 1 && day <= 3)) reasons.push('年末年始');
    const key = value.slice(5);
    if((official ? OFFICIAL[year].includes(key) : predictedHolidaySet(year).has(key))) reasons.push('国民の祝日・休日');
    return {closed:reasons.length > 0,reasons,confidence:official ? 'official' : 'provisional'};
  }
  function adjustDueDate(rawDueDate){
    if(!parseDate(rawDueDate)) return {status:'unavailable',adjustedDueDate:null,adjustmentReasons:['期限の日付が不正です。'],confidence:'unknown',calendarVersion:VERSION};
    let date = rawDueDate, confidence = 'official';
    const reasons = [];
    for(let i=0;i<15;i++){
      const info = holidayInfo(date);
      if(info.confidence === 'unknown') return {status:'unavailable',adjustedDueDate:null,adjustmentReasons:info.reasons,confidence:'unknown',calendarVersion:VERSION};
      if(info.confidence !== 'official') confidence = 'provisional';
      if(!info.closed) return {status:'ready',adjustedDueDate:date,adjustmentReasons:[...new Set(reasons)],confidence,calendarVersion:VERSION};
      reasons.push(...info.reasons);
      date = shiftDays(date,1);
    }
    return {status:'unavailable',adjustedDueDate:null,adjustmentReasons:['休日繰延べを確定できません。'],confidence:'unknown',calendarVersion:VERSION};
  }
  return {VERSION,parseDate,shiftDays,shiftMonths,periodEnd,priorMonths,deadlineAfterPeriod,deadlineFromStart,holidayInfo,adjustDueDate};
});
