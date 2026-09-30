import { describe, expect, it, beforeEach, vi } from 'vitest';
import { $, Q } from './q';

describe('q — the DOM facade that replaced jQuery', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="box" class="panel" data-minutes="5" data-label="hello">
        <span class="child">one</span>
        <span class="child">two</span>
      </div>
      <input id="check" type="checkbox" checked />
      <input id="text" type="text" value="abc" />
      <div id="hidden-box" style="display: none"></div>
      <div id="target"><p class="deep">deep</p></div>
    `;
  });

  it('selects by selector, element, document, and html string', () => {
    expect($('#box').length).toBe(1);
    expect($(document.getElementById('box') as Element).length).toBe(1);
    expect($(document).length).toBe(1);
    const created = $('<div class="made"></div><p></p>');
    expect(created.length).toBe(2);
    expect((created.get(0) as Element).tagName).toBe('DIV');
    expect(new Q([]).length).toBe(0);
  });

  it('reports length and get/eq accessors', () => {
    const children = $('#box').children();
    expect(children.length).toBe(2);
    expect(children.eq(1).get(0)?.textContent).toBe('two');
    expect(children.eq(-1).get(0)?.textContent).toBe('two');
    expect(children.eq(9).length).toBe(0);
  });

  it('each/map use the (index, element) argument order', () => {
    const seen: string[] = [];
    $('#box')
      .children()
      .each((i, el) => {
        seen.push(`${i}:${(el as Element).textContent}`);
      });
    expect(seen).toEqual(['0:one', '1:two']);

    const texts = $('#box')
      .children()
      .map((i, el) => `${i}-${(el as Element).textContent}`)
      .sort();
    expect(texts).toEqual(['0-one', '1-two']);
  });

  it('find/closest/children/filter/not/is work like the jQuery subset used', () => {
    expect($('#target').find('.deep').text()).toBe('deep');
    expect($('.deep').closest('#target').length).toBe(1);
    expect($('#box').children('.child').length).toBe(2);
    expect(
      $('#box')
        .children()
        .filter((i) => i === 0)
        .text(),
    ).toBe('one');
    expect($('#box').children().not('.child').length).toBe(0);
    expect($('#check').is(':checked')).toBe(true);
    expect($('#text').is(':checked')).toBe(false);
    expect($('#hidden-box').is(':hidden')).toBe(true);
  });

  it('text/html/val/attr/prop round-trip', () => {
    $('#box').text('replaced');
    expect(document.getElementById('box')?.textContent).toBe('replaced');

    $('#target').html('<b>bold</b>');
    expect(document.querySelector('#target b')?.textContent).toBe('bold');

    expect($('#text').val()).toBe('abc');
    $('#text').val('xyz');
    expect((document.getElementById('text') as HTMLInputElement).value).toBe('xyz');

    $('#box').attr('data-x', '1');
    expect(document.getElementById('box')?.getAttribute('data-x')).toBe('1');
    expect($('#box').attr('data-x')).toBe('1');
    $('#box').removeAttr('data-x');
    expect($('#box').attr('data-x')).toBeNull();

    $('#check').prop('checked', false);
    expect((document.getElementById('check') as HTMLInputElement).checked).toBe(false);
  });

  it('data() applies the jQuery value coercion', () => {
    expect($('#box').data('minutes')).toBe(5);
    expect($('#box').data('label')).toBe('hello');
    expect($('#box').data('missing')).toBeNull();
  });

  it('class methods mutate classList', () => {
    const box = $('#box');
    box.addClass('extra other');
    expect(document.getElementById('box')?.classList.contains('other')).toBe(true);
    box.removeClass('extra other');
    expect(document.getElementById('box')?.classList.contains('other')).toBe(false);
    box.toggleClass('flip');
    expect(box.hasClass('flip')).toBe(true);
    box.toggleClass('flip', false);
    expect(box.hasClass('flip')).toBe(false);
  });

  it('show/hide restore the previous inline display', () => {
    const box = $('#box');
    box.hide();
    expect((document.getElementById('box') as HTMLElement).style.display).toBe('none');
    box.show();
    expect((document.getElementById('box') as HTMLElement).style.display).toBe('');
  });

  it('append/empty/remove/replaceWith build and tear down DOM', () => {
    const box = $('#box');
    box.append('<em id="added">added</em>');
    expect(document.getElementById('added')?.textContent).toBe('added');

    box.append($('<b id="moved">b</b>'));
    expect(document.querySelectorAll('#box b')).toHaveLength(1);

    $('#box').empty();
    expect(document.getElementById('box')?.children).toHaveLength(0);

    $('#target').append('<p id="p2">x</p>');
    $('#p2').remove();
    expect(document.getElementById('p2')).toBeNull();

    $('#target').append('<span id="old">old</span>');
    $('#old').replaceWith('<span id="new">new</span>');
    expect(document.getElementById('old')).toBeNull();
    expect(document.getElementById('new')?.textContent).toBe('new');
  });

  it('binds direct handlers with this = element and fires on native events', () => {
    const seen: { thisValue: unknown; originalIsSelf: boolean }[] = [];
    $('#check').on('change', function (this: HTMLElement, event) {
      seen.push({ thisValue: this, originalIsSelf: event.originalEvent === event });
    });
    document.getElementById('check')?.dispatchEvent(new Event('change', { bubbles: true }));
    expect(seen).toHaveLength(1);
    expect(seen[0].thisValue).toBe(document.getElementById('check'));
    expect(seen[0].originalIsSelf).toBe(true);
  });

  it('delegates events and binds this to the matched element', () => {
    const seen: Element[] = [];
    $(document).on('click', '.child', function (this: HTMLElement) {
      seen.push(this as Element);
    });
    document
      .querySelector('#box .child')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(seen).toHaveLength(1);
    expect(seen[0].textContent).toBe('one');
  });

  it('off removes the handler; one fires exactly once', () => {
    const handler = vi.fn();
    const box = $('#box');
    box.on('click', handler);
    box.off('click', handler);
    box.trigger('click');
    expect(handler).not.toHaveBeenCalled();

    const onceHandler = vi.fn();
    box.one('click', onceHandler);
    box.trigger('click');
    box.trigger('click');
    expect(onceHandler).toHaveBeenCalledTimes(1);
  });

  it('trigger calls native methods for focus/click and dispatches custom events', () => {
    const focusSpy = vi.fn();
    const input = $('#text');
    input.get(0)?.addEventListener('focus', focusSpy);
    input.trigger('focus');
    expect(focusSpy).toHaveBeenCalled();

    const seen = vi.fn();
    $('#box').get(0)?.addEventListener('pings', seen);
    $('#box').trigger('pings');
    expect(seen).toHaveBeenCalled();
  });

  it('css sets inline styles; scrollTop stores what it is given', () => {
    $('#box').css('font-size', '21px');
    expect((document.getElementById('box') as HTMLElement).style.fontSize).toBe('21px');
    $('#box').css({ 'line-height': '2', padding: '3px' });
    expect((document.getElementById('box') as HTMLElement).style.lineHeight).toBe('2');

    const scroller = $('<div id="scroller"></div>');
    expect(scroller.scrollTop(120)).toBe(scroller);
  });

  it('chains', () => {
    $('#box').addClass('a').removeClass('a').toggleClass('b').text('chained');
    expect(document.getElementById('box')?.textContent).toBe('chained');
  });
});
