// ===== utils.js — 工具函数集 =====
// 依赖: api.js (fetch 已被 monkey-patch)

/**
 * SVG 图标库（heroicons outline，离线可用）
 * P7-6: 统一为 heroicons（viewBox 24×24, 1.5px 描边）
 * @param {string} name - 图标名: check | cross | warn | close | trash | doc | books | idea | book | spin | play | pause | search | write | think | stop | file | chat | send | cloud | brain | home | lock | light | books2 | refresh | gear | chart | slides
 * @param {string} [size='14'] - 宽高像素
 * @returns {string} 内联 SVG HTML 片段
 */
function iconSvg(name, size) {
  if (!size) size = '14';
  var _s = 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';
  var _w = 'width="'+size+'" height="'+size+'" viewBox="0 0 24 24" '+_s+' style="vertical-align:-3px"';
  var _wa = 'width="'+size+'" height="'+size+'" viewBox="0 0 24 24" '+_s+' style="vertical-align:-3px;animation:spin .8s linear infinite"';
  var icons = {
    check: '<svg '+_w+'><path d="M4.5 12.75L10.5 18.75L19.5 5.25"/></svg>',
    cross: '<svg '+_w+'><path d="M9.75 9.75L14.25 14.25M14.25 9.75L9.75 14.25M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12Z"/></svg>',
    warn: '<svg '+_w+'><path d="M11.9998 9.00006V12.7501M2.69653 16.1257C1.83114 17.6257 2.91371 19.5001 4.64544 19.5001H19.3541C21.0858 19.5001 22.1684 17.6257 21.303 16.1257L13.9487 3.37819C13.0828 1.87736 10.9167 1.87736 10.0509 3.37819L2.69653 16.1257ZM11.9998 15.7501H12.0073V15.7576H11.9998V15.7501Z"/></svg>',
    close: '<svg '+_w+'><path d="M6 18L18 6M6 6L18 18"/></svg>',
    trash: '<svg '+_w+'><path d="M14.7404 9L14.3942 18M9.60577 18L9.25962 9M19.2276 5.79057C19.5696 5.84221 19.9104 5.89747 20.25 5.95629M19.2276 5.79057L18.1598 19.6726C18.0696 20.8448 17.0921 21.75 15.9164 21.75H8.08357C6.90786 21.75 5.93037 20.8448 5.8402 19.6726L4.77235 5.79057M19.2276 5.79057C18.0812 5.61744 16.9215 5.48485 15.75 5.39432M3.75 5.95629C4.08957 5.89747 4.43037 5.84221 4.77235 5.79057M4.77235 5.79057C5.91878 5.61744 7.07849 5.48485 8.25 5.39432M15.75 5.39432V4.47819C15.75 3.29882 14.8393 2.31423 13.6606 2.27652C13.1092 2.25889 12.5556 2.25 12 2.25C11.4444 2.25 10.8908 2.25889 10.3394 2.27652C9.16065 2.31423 8.25 3.29882 8.25 4.47819V5.39432M15.75 5.39432C14.5126 5.2987 13.262 5.25 12 5.25C10.738 5.25 9.48744 5.2987 8.25 5.39432"/></svg>',
    doc: '<svg '+_w+'><path d="M19.5 14.25V11.625C19.5 9.76104 17.989 8.25 16.125 8.25H14.625C14.0037 8.25 13.5 7.74632 13.5 7.125V5.625C13.5 3.76104 11.989 2.25 10.125 2.25H8.25M8.25 15H15.75M8.25 18H12M10.5 2.25H5.625C5.00368 2.25 4.5 2.75368 4.5 3.375V20.625C4.5 21.2463 5.00368 21.75 5.625 21.75H18.375C18.9963 21.75 19.5 21.2463 19.5 20.625V11.25C19.5 6.27944 15.4706 2.25 10.5 2.25Z"/></svg>',
    books: '<svg '+_w+'><path d="M12 6.04168C10.4077 4.61656 8.30506 3.75 6 3.75C4.94809 3.75 3.93834 3.93046 3 4.26212V18.5121C3.93834 18.1805 4.94809 18 6 18C8.30506 18 10.4077 18.8666 12 20.2917M12 6.04168C13.5923 4.61656 15.6949 3.75 18 3.75C19.0519 3.75 20.0617 3.93046 21 4.26212V18.5121C20.0617 18.1805 19.0519 18 18 18C15.6949 18 13.5923 18.8666 12 20.2917M12 6.04168V20.2917"/></svg>',
    idea: '<svg '+_w+'><path d="M12 18V12.75M12 12.75C12.5179 12.75 13.0206 12.6844 13.5 12.561M12 12.75C11.4821 12.75 10.9794 12.6844 10.5 12.561M14.25 20.0394C13.5212 20.1777 12.769 20.25 12 20.25C11.231 20.25 10.4788 20.1777 9.75 20.0394M13.5 22.422C13.007 22.4736 12.5066 22.5 12 22.5C11.4934 22.5 10.993 22.4736 10.5 22.422M14.25 18V17.8083C14.25 16.8254 14.9083 15.985 15.7585 15.4917C17.9955 14.1938 19.5 11.7726 19.5 9C19.5 4.85786 16.1421 1.5 12 1.5C7.85786 1.5 4.5 4.85786 4.5 9C4.5 11.7726 6.00446 14.1938 8.24155 15.4917C9.09173 15.985 9.75 16.8254 9.75 17.8083V18"/></svg>',
    book: '<svg '+_w+'><path d="M12 6.04168C10.4077 4.61656 8.30506 3.75 6 3.75C4.94809 3.75 3.93834 3.93046 3 4.26212V18.5121C3.93834 18.1805 4.94809 18 6 18C8.30506 18 10.4077 18.8666 12 20.2917M12 6.04168C13.5923 4.61656 15.6949 3.75 18 3.75C19.0519 3.75 20.0617 3.93046 21 4.26212V18.5121C20.0617 18.1805 19.0519 18 18 18C15.6949 18 13.5923 18.8666 12 20.2917M12 6.04168V20.2917"/></svg>',
    spin: '<svg '+_wa+'><path d="M16.0228 9.34841H21.0154V9.34663M2.98413 19.6444V14.6517M2.98413 14.6517L7.97677 14.6517M2.98413 14.6517L6.16502 17.8347C7.15555 18.8271 8.41261 19.58 9.86436 19.969C14.2654 21.1483 18.7892 18.5364 19.9685 14.1353M4.03073 9.86484C5.21 5.46374 9.73377 2.85194 14.1349 4.03121C15.5866 4.4202 16.8437 5.17312 17.8342 6.1655L21.0154 9.34663M21.0154 4.3558V9.34663"/></svg>',
    play: '<svg '+_w+'><path d="M5.25 5.65273C5.25 4.79705 6.1674 4.25462 6.91716 4.66698L18.4577 11.0143C19.2349 11.4417 19.2349 12.5584 18.4577 12.9858L6.91716 19.3331C6.1674 19.7455 5.25 19.203 5.25 18.3474V5.65273Z"/></svg>',
    pause: '<svg '+_w+'><path d="M15.75 5.25L15.75 18.75M8.25 5.25V18.75"/></svg>',
    search: '<svg '+_w+'><path d="M21 21L15.8033 15.8033M15.8033 15.8033C17.1605 14.4461 18 12.5711 18 10.5C18 6.35786 14.6421 3 10.5 3C6.35786 3 3 6.35786 3 10.5C3 14.6421 6.35786 18 10.5 18C12.5711 18 14.4461 17.1605 15.8033 15.8033Z"/></svg>',
    write: '<svg '+_w+'><path d="M16.8617 4.48667L18.5492 2.79917C19.2814 2.06694 20.4686 2.06694 21.2008 2.79917C21.9331 3.53141 21.9331 4.71859 21.2008 5.45083L6.83218 19.8195C6.30351 20.3481 5.65144 20.7368 4.93489 20.9502L2.25 21.75L3.04978 19.0651C3.26323 18.3486 3.65185 17.6965 4.18052 17.1678L16.8617 4.48667ZM16.8617 4.48667L19.5 7.12499"/></svg>',
    think: '<svg '+_w+'><path d="M2.25 15C2.25 17.4853 4.26472 19.5 6.75 19.5H18C20.0711 19.5 21.75 17.8211 21.75 15.75C21.75 14.1479 20.7453 12.7805 19.3316 12.2433C19.4407 11.9324 19.5 11.5981 19.5 11.25C19.5 9.59315 18.1569 8.25 16.5 8.25C16.1767 8.25 15.8654 8.30113 15.5737 8.39575C14.9765 6.1526 12.9312 4.5 10.5 4.5C7.6005 4.5 5.25 6.85051 5.25 9.75C5.25 10.0832 5.28105 10.4092 5.3404 10.7252C3.54555 11.3167 2.25 13.0071 2.25 15Z"/></svg>',
    stop: '<svg '+_w+'><path d="M5.25 7.5C5.25 6.25736 6.25736 5.25 7.5 5.25H16.5C17.7426 5.25 18.75 6.25736 18.75 7.5V16.5C18.75 17.7426 17.7426 18.75 16.5 18.75H7.5C6.25736 18.75 5.25 17.7426 5.25 16.5V7.5Z"/></svg>',
    file: '<svg '+_w+'><path d="M19.5 14.25V11.625C19.5 9.76104 17.989 8.25 16.125 8.25H14.625C14.0037 8.25 13.5 7.74632 13.5 7.125V5.625C13.5 3.76104 11.989 2.25 10.125 2.25H8.25M10.5 2.25H5.625C5.00368 2.25 4.5 2.75368 4.5 3.375V20.625C4.5 21.2463 5.00368 21.75 5.625 21.75H18.375C18.9963 21.75 19.5 21.2463 19.5 20.625V11.25C19.5 6.27944 15.4706 2.25 10.5 2.25Z"/></svg>',
    chat: '<svg '+_w+'><path d="M7.5 8.25H16.5M7.5 11.25H12M2.25 12.7593C2.25 14.3604 3.37341 15.754 4.95746 15.987C6.08596 16.1529 7.22724 16.2796 8.37985 16.3655C8.73004 16.3916 9.05017 16.5753 9.24496 16.8674L12 21L14.755 16.8675C14.9498 16.5753 15.2699 16.3917 15.6201 16.3656C16.7727 16.2796 17.914 16.153 19.0425 15.9871C20.6266 15.7542 21.75 14.3606 21.75 12.7595V6.74056C21.75 5.13946 20.6266 3.74583 19.0425 3.51293C16.744 3.17501 14.3926 3 12.0003 3C9.60776 3 7.25612 3.17504 4.95747 3.51302C3.37342 3.74593 2.25 5.13956 2.25 6.74064V12.7593Z"/></svg>',
    send: '<svg '+_w+'><path d="M5.99972 12L3.2688 3.12451C9.88393 5.04617 16.0276 8.07601 21.4855 11.9997C16.0276 15.9235 9.884 18.9535 3.26889 20.8752L5.99972 12ZM5.99972 12L13.5 12"/></svg>',
    cloud: '<svg '+_w+'><path d="M2.25 15C2.25 17.4853 4.26472 19.5 6.75 19.5H18C20.0711 19.5 21.75 17.8211 21.75 15.75C21.75 14.1479 20.7453 12.7805 19.3316 12.2433C19.4407 11.9324 19.5 11.5981 19.5 11.25C19.5 9.59315 18.1569 8.25 16.5 8.25C16.1767 8.25 15.8654 8.30113 15.5737 8.39575C14.9765 6.1526 12.9312 4.5 10.5 4.5C7.6005 4.5 5.25 6.85051 5.25 9.75C5.25 10.0832 5.28105 10.4092 5.3404 10.7252C3.54555 11.3167 2.25 13.0071 2.25 15Z"/></svg>',
    brain: '<svg '+_w+'><path d="M9.8132 15.9038L9 18.75L8.1868 15.9038C7.75968 14.4089 6.59112 13.2403 5.09619 12.8132L2.25 12L5.09619 11.1868C6.59113 10.7597 7.75968 9.59112 8.1868 8.09619L9 5.25L9.8132 8.09619C10.2403 9.59113 11.4089 10.7597 12.9038 11.1868L15.75 12L12.9038 12.8132C11.4089 13.2403 10.2403 14.4089 9.8132 15.9038Z"/><path d="M18.2589 8.71454L18 9.75L17.7411 8.71454C17.4388 7.50533 16.4947 6.56117 15.2855 6.25887L14.25 6L15.2855 5.74113C16.4947 5.43883 17.4388 4.49467 17.7411 3.28546L18 2.25L18.2589 3.28546C18.5612 4.49467 19.5053 5.43883 20.7145 5.74113L21.75 6L20.7145 6.25887C19.5053 6.56117 18.5612 7.50533 18.2589 8.71454Z"/><path d="M16.8942 20.5673L16.5 21.75L16.1058 20.5673C15.8818 19.8954 15.3546 19.3682 14.6827 19.1442L13.5 18.75L14.6827 18.3558C15.3546 18.1318 15.8818 17.6046 16.1058 16.9327L16.5 15.75L16.8942 16.9327C17.1182 17.6046 17.6454 18.1318 18.3173 18.3558L19.5 18.75L18.3173 19.1442C17.6454 19.3682 17.1182 19.8954 16.8942 20.5673Z"/></svg>',
    home: '<svg '+_w+'><path d="M2.25 12L11.2045 3.04549C11.6438 2.60615 12.3562 2.60615 12.7955 3.04549L21.75 12M4.5 9.75V19.875C4.5 20.4963 5.00368 21 5.625 21H9.75V16.125C9.75 15.5037 10.2537 15 10.875 15H13.125C13.7463 15 14.25 15.5037 14.25 16.125V21H18.375C18.9963 21 19.5 20.4963 19.5 19.875V9.75M8.25 21H16.5"/></svg>',
    lock: '<svg '+_w+'><path d="M16.5 10.5V6.75C16.5 4.26472 14.4853 2.25 12 2.25C9.51472 2.25 7.5 4.26472 7.5 6.75V10.5M6.75 21.75H17.25C18.4926 21.75 19.5 20.7426 19.5 19.5V12.75C19.5 11.5074 18.4926 10.5 17.25 10.5H6.75C5.50736 10.5 4.5 11.5074 4.5 12.75V19.5C4.5 20.7426 5.50736 21.75 6.75 21.75Z"/></svg>',
    light: '<svg '+_w+'><path d="M12 3V5.25M18.364 5.63604L16.773 7.22703M21 12H18.75M18.364 18.364L16.773 16.773M12 18.75V21M7.22703 16.773L5.63604 18.364M5.25 12H3M7.22703 7.22703L5.63604 5.63604M15.75 12C15.75 14.0711 14.0711 15.75 12 15.75C9.92893 15.75 8.25 14.0711 8.25 12C8.25 9.92893 9.92893 8.25 12 8.25C14.0711 8.25 15.75 9.92893 15.75 12Z"/></svg>',
    books2: '<svg '+_w+'><path d="M12 6.04168C10.4077 4.61656 8.30506 3.75 6 3.75C4.94809 3.75 3.93834 3.93046 3 4.26212V18.5121C3.93834 18.1805 4.94809 18 6 18C8.30506 18 10.4077 18.8666 12 20.2917M12 6.04168C13.5923 4.61656 15.6949 3.75 18 3.75C19.0519 3.75 20.0617 3.93046 21 4.26212V18.5121C20.0617 18.1805 19.0519 18 18 18C15.6949 18 13.5923 18.8666 12 20.2917M12 6.04168V20.2917"/></svg>',
    refresh: '<svg '+_w+'><path d="M16.0228 9.34841H21.0154V9.34663M2.98413 19.6444V14.6517M2.98413 14.6517L7.97677 14.6517M2.98413 14.6517L6.16502 17.8347C7.15555 18.8271 8.41261 19.58 9.86436 19.969C14.2654 21.1483 18.7892 18.5364 19.9685 14.1353M4.03073 9.86484C5.21 5.46374 9.73377 2.85194 14.1349 4.03121C15.5866 4.4202 16.8437 5.17312 17.8342 6.1655L21.0154 9.34663M21.0154 4.3558V9.34663"/></svg>',
    gear: '<svg '+_w+'><path d="M9.59356 3.94014C9.68397 3.39768 10.1533 3.00009 10.7033 3.00009H13.2972C13.8472 3.00009 14.3165 3.39768 14.4069 3.94014L14.6204 5.22119C14.6828 5.59523 14.9327 5.9068 15.2645 6.09045C15.3387 6.13151 15.412 6.17393 15.4844 6.21766C15.8095 6.41393 16.2048 6.47495 16.5604 6.34175L17.7772 5.88587C18.2922 5.69293 18.8712 5.9006 19.1462 6.37687L20.4432 8.6233C20.7181 9.09957 20.6085 9.70482 20.1839 10.0544L19.1795 10.8812C18.887 11.122 18.742 11.4938 18.7491 11.8726C18.7498 11.915 18.7502 11.9575 18.7502 12.0001C18.7502 12.0427 18.7498 12.0852 18.7491 12.1275C18.742 12.5064 18.887 12.8782 19.1795 13.119L20.1839 13.9458C20.6085 14.2953 20.7181 14.9006 20.4432 15.3769L19.1462 17.6233C18.8712 18.0996 18.2922 18.3072 17.7772 18.1143L16.5604 17.6584C16.2048 17.5252 15.8095 17.5862 15.4844 17.7825C15.412 17.8263 15.3387 17.8687 15.2645 17.9097C14.9327 18.0934 14.6828 18.4049 14.6204 18.779L14.4069 20.06C14.3165 20.6025 13.8472 21.0001 13.2972 21.0001H10.7033C10.1533 21.0001 9.68397 20.6025 9.59356 20.06L9.38005 18.779C9.31771 18.4049 9.06774 18.0934 8.73597 17.9097C8.66179 17.8687 8.58847 17.8263 8.51604 17.7825C8.19101 17.5863 7.79568 17.5252 7.44011 17.6584L6.22325 18.1143C5.70826 18.3072 5.12926 18.0996 4.85429 17.6233L3.55731 15.3769C3.28234 14.9006 3.39199 14.2954 3.81657 13.9458L4.82092 13.119C5.11343 12.8782 5.25843 12.5064 5.25141 12.1276C5.25063 12.0852 5.25023 12.0427 5.25023 12.0001C5.25023 11.9575 5.25063 11.915 5.25141 11.8726C5.25843 11.4938 5.11343 11.122 4.82092 10.8812L3.81657 10.0544C3.39199 9.70484 3.28234 9.09958 3.55731 8.62332L4.85429 6.37688C5.12926 5.90061 5.70825 5.69295 6.22325 5.88588L7.4401 6.34176C7.79566 6.47496 8.19099 6.41394 8.51603 6.21767C8.58846 6.17393 8.66179 6.13151 8.73597 6.09045C9.06774 5.9068 9.31771 5.59523 9.38005 5.22119L9.59356 3.94014Z"/><path d="M15 12C15 13.6569 13.6569 15 12 15C10.3431 15 9 13.6569 9 12C9 10.3432 10.3431 9.00001 12 9.00001C13.6569 9.00001 15 10.3432 15 12Z"/></svg>',
    chart: '<svg '+_w+'><path d="M3 13.125C3 12.5037 3.50368 12 4.125 12H6.375C6.99632 12 7.5 12.5037 7.5 13.125V19.875C7.5 20.4963 6.99632 21 6.375 21H4.125C3.50368 21 3 20.4963 3 19.875V13.125Z"/><path d="M9.75 8.625C9.75 8.00368 10.2537 7.5 10.875 7.5H13.125C13.7463 7.5 14.25 8.00368 14.25 8.625V19.875C14.25 20.4963 13.7463 21 13.125 21H10.875C10.2537 21 9.75 20.4963 9.75 19.875V8.625Z"/><path d="M16.5 4.125C16.5 3.50368 17.0037 3 17.625 3H19.875C20.4963 3 21 3.50368 21 4.125V19.875C21 20.4963 20.4963 21 19.875 21H17.625C17.0037 21 16.5 20.4963 16.5 19.875V4.125Z"/></svg>',
    slides: '<svg '+_w+'><path d="M3.75 3V14.25C3.75 15.4926 4.75736 16.5 6 16.5H8.25M3.75 3H2.25M3.75 3H20.25M20.25 3H21.75M20.25 3V14.25C20.25 15.4926 19.2426 16.5 18 16.5H15.75M8.25 16.5H15.75M8.25 16.5L7.25 19.5M15.75 16.5L16.75 19.5M16.75 19.5L17.25 21M16.75 19.5H7.25M7.25 19.5L6.75 21M7.5 12L10.5 9L12.6476 11.1476C13.6542 9.70301 14.9704 8.49023 16.5 7.60539"/></svg>'
  };
  return icons[name] || '';
}
window.iconSvg = iconSvg;

/**
 * HTML 转义
 * @param {string} s - 原始字符串
 * @returns {string} 转义后的安全字符串
 */
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 属性值转义（用于 onclick 等内联事件属性）
 */
function escAttr(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * 格式化 MB 值
 * @param {number} mb - 兆字节数
 * @returns {string} 格式化后的字符串
 */
function fmtMB(mb) {
  if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
  if (mb > 0) return Math.round(mb) + ' MB';
  return '0 MB';
}

/**
 * 自动调整 textarea 高度
 * @param {HTMLTextAreaElement} el - textarea 元素
 */
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

/**
 * 格式化时间（秒 → mm:ss）
 * @param {number} seconds - 秒数
 * @returns {string} 格式化后的时间字符串
 */
function formatTime(seconds) {
  if (!seconds || isNaN(seconds) || !isFinite(seconds)) return '00:00';
  var m = Math.floor(seconds / 60);
  var s = Math.floor(seconds % 60);
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

/**
 * 显示加载遮罩
 * @param {string} text - 加载提示文本
 * @param {boolean} showProgress - 是否显示进度条
 */
function showLoading(text, showProgress) {
  var loadingText = document.getElementById('loadingText');
  if (!loadingText) return;
  loadingText.textContent = text || '加载中...';
  var bar = document.getElementById('loadingProgress');
  if (!bar) return;
  if (showProgress) {
    bar.style.display = 'block';
    var fill = bar.querySelector('.fill');
    fill.style.animation = 'none';
    fill.style.width = '30%';
    fill.style.animation = 'indeterminateProgress 1.5s ease-in-out infinite';
  } else {
    bar.style.display = 'none';
  }
  document.getElementById('loadingOverlay').style.display = 'flex';
}

/**
 * 隐藏加载遮罩
 */
function hideLoading() {
  var overlay = document.getElementById('loadingOverlay');
  if (overlay) overlay.style.display = 'none';
  var bar = document.getElementById('loadingProgress');
  if (bar) bar.style.display = 'none';
}

/**
 * 显示模块加载覆层（切 tab 不丢失状态）
 * @param {string} title - 标题文字，如 "纪要引擎加载中"
 * @param {string} iconType - 图标类型: "model" | "whisper" | "kb"
 * @param {string} [hint] - 底部提示文字
 */
function showModuleLoading(title, iconType, hint) {
  var overlay = document.getElementById('moduleLoadingOverlay');
  var iconEl = document.getElementById('moduleLoadingIcon');
  var titleEl = document.getElementById('moduleLoadingTitle');
  var hintEl = document.getElementById('moduleLoadingHint');
  if (!overlay) return;

  var icons = {
    model: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.3"/><path d="M12 6v6l4 2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    whisper: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M12 3a4 4 0 0 0-4 4v4a4 4 0 0 0 8 0V7a4 4 0 0 0-4-4z" stroke="currentColor" stroke-width="1.3"/><path d="M19 11v1a7 7 0 0 1-14 0v-1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="12" y1="19" x2="12" y2="21" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="8" y1="21" x2="16" y2="21" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    kb: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><rect x="2" y="2" width="8" height="8" rx="2" stroke="currentColor" stroke-width="1.3"/><rect x="14" y="2" width="8" height="8" rx="2" stroke="currentColor" stroke-width="1.3"/><rect x="2" y="14" width="8" height="8" rx="2" stroke="currentColor" stroke-width="1.3"/><rect x="14" y="14" width="8" height="8" rx="2" stroke="currentColor" stroke-width="1.3"/></svg>'
  };

  if (iconEl) iconEl.innerHTML = icons[iconType] || icons.model;
  if (titleEl) titleEl.textContent = title || '加载中';
  if (hintEl) hintEl.textContent = hint || '首次加载约需 10-30 秒';
  overlay.style.display = 'flex';
}

/**
 * 隐藏模块加载覆层
 */
function hideModuleLoading() {
  var overlay = document.getElementById('moduleLoadingOverlay');
  if (overlay) overlay.style.display = 'none';
}

// ===== LaTeX 渲染工具 =====

/**
 * 渲染单个 LaTeX 公式
 * @param {string} latex - LaTeX 源码
 * @param {boolean} displayMode - 是否为 display 模式
 * @returns {string} 渲染后的 HTML
 */
function _renderLatex(latex, displayMode) {
  if (typeof katex !== 'undefined') {
    try {
      return katex.renderToString(latex, {
        displayMode: displayMode,
        throwOnError: false,
        output: 'htmlAndMathml'
      });
    } catch(e) {}
  }
  return esc(latex);
}

/**
 * 提取并渲染 LaTeX 公式（用占位符保护）
 * @param {string} text - 原始文本
 * @returns {object} { text: 处理后文本, placeholders: 占位符数组 }
 */
function _extractAndRenderLatex(text) {
  var placeholders = [];
  // 先处理 $$...$$ (display mode)
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, function(m, latex) {
    placeholders.push('<div class="latex-display">' + _renderLatex(latex.trim(), true) + '</div>');
    return '\x01LX' + (placeholders.length - 1) + '\x01';
  });
  // 再处理 $...$ (inline)
  text = text.replace(/\$([^\$\n]+?)\$/g, function(m, latex) {
    placeholders.push('<span class="latex-inline">' + _renderLatex(latex.trim(), false) + '</span>');
    return '\x01LX' + (placeholders.length - 1) + '\x01';
  });
  return { text: text, placeholders: placeholders };
}

/**
 * 恢复 LaTeX 占位符为渲染后的 HTML
 * @param {string} text - 含占位符的文本
 * @param {Array} placeholders - 占位符数组
 * @returns {string} 最终 HTML
 */
function _restoreLatex(text, placeholders) {
  return text.replace(/\x01LX(\d+)\x01/g, function(m, idx) {
    return placeholders[parseInt(idx)] || m;
  });
}

/**
 * Markdown → HTML（使用 marked.js 增强渲染，流式安全）
 * 支持：表格、任务列表、脚注、图片、删除线、水平线、嵌套列表、代码高亮
 * @param {string} text - Markdown 源码
 * @returns {string} HTML
 */

// P6: Mermaid 初始化 + 异步渲染
if (typeof mermaid !== 'undefined') {
  // 关键: fontFamily 必须用显式字体而非 'inherit'。
  // mermaid 库在测量节点尺寸时若拿到 'inherit'(无具体字体)会用 fallback 字体度量,
  // 但实际 SVG 渲染时 foreignObject 内继承的是系统字体(行高更大),
  // 导致测量框偏小、中文多行文字溢出框外不可读。
  // 用系统默认字体栈保持测量/渲染一致。
  mermaid.initialize({
    startOnLoad: false,
    theme: 'default',
    securityLevel: 'loose',
    fontFamily: '"Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, "PingFang SC", "Microsoft YaHei", sans-serif',
    flowchart: {
      padding: 12,
      nodeSpacing: 60,
      rankSpacing: 60,
      useMaxWidth: false
    }
  });
}

function _renderMermaid(el) {
  if (!el || typeof mermaid === 'undefined') return;
  var containers = el.querySelectorAll('.mermaid-container:not([data-rendered])');
  // mermaid.render() 同步部分会把待渲染的容器临时移到 body 末尾做测量，
  // 但在 promise resolve 前不会放回——若期间发生其他 DOM 重建（如 renderMessages
  // 二次调用、流式追加），容器会永久脱离原位置，导致图表"渲染中"占位消失。
  // 修复：渲染前记住原位置，promise settle 后无条件放回。
  var list = Array.prototype.slice.call(containers);
  list.forEach(function(container) {
    var code = decodeURIComponent(container.getAttribute('data-mermaid') || '');
    if (!code) return;
    try {
      var id = container.id || ('mermaid-' + Math.random().toString(36).slice(2, 10));
      var parent = container.parentElement;
      var nextSibling = container.nextSibling;
      mermaid.render(id, code).then(function(result) {
        container.setAttribute('data-rendered', '1');
        // 兜底：若 mermaid 库在测量过程中让容器脱离了原位，放回去
        if (!container.parentElement) {
          if (nextSibling && nextSibling.parentElement === parent) {
            parent.insertBefore(container, nextSibling);
          } else if (parent) {
            parent.appendChild(container);
          }
        }
        // Issue2.2/4: 渲染成功后挂载工具栏(下载SVG) + 缩放拖拽交互
        container.innerHTML = result.svg;
        _enhanceMermaid(container, code);
      }).catch(function(err) {
        container.setAttribute('data-rendered', '1');
        container.setAttribute('data-fix-status', 'failed');
        container.setAttribute('data-fix-error', String(err.message || err).slice(0, 300));
        // Issue2.1: 显示"自动修复中"提示（图内位置），并触发修复流程
        container.innerHTML = '<div class="mermaid-fixing"><span class="mf-dot"></span>图表语法有误，AI 正在自动修复...</div>';
        // 失败也要放回原位
        if (!container.parentElement && parent) {
          if (nextSibling && nextSibling.parentElement === parent) {
            parent.insertBefore(container, nextSibling);
          } else {
            parent.appendChild(container);
          }
        }
        // 触发自动修复（收集原始代码 + 错误 + 用户问题）
        if (typeof _triggerMermaidFix === 'function') {
          _triggerMermaidFix(container, code, String(err.message || err).slice(0, 300));
        }
      });
    } catch(err) {
      // 同步异常路径：不设 data-rendered，允许下次重试
      container.innerHTML = '<div class="mermaid-fixing"><span class="mf-dot"></span>图表语法有误，AI 正在自动修复...</div>';
      container.setAttribute('data-fix-status', 'failed');
      container.setAttribute('data-fix-error', String(err).slice(0, 300));
      // 同步异常也可能发生在 mermaid.render 已挪走容器之后，同样兜底放回
      if (!container.parentElement && parent) {
        if (nextSibling && nextSibling.parentElement === parent) {
          parent.insertBefore(container, nextSibling);
        } else {
          parent.appendChild(container);
        }
      }
      if (typeof _triggerMermaidFix === 'function') {
        _triggerMermaidFix(container, code, String(err).slice(0, 300));
      }
    }
  });
}
window._renderMermaid = _renderMermaid;

// Issue2.2 + Issue4: mermaid 容器增强——下载 SVG + 缩放拖拽
function _enhanceMermaid(container, code) {
  if (!container || container.querySelector('.mermaid-toolbar')) return;  // 防重复挂载
  var svg = container.querySelector('svg');
  if (!svg) return;

  // --- 工具栏（下载 SVG + 缩放百分比 + 复位）---
  var toolbar = document.createElement('div');
  toolbar.className = 'mermaid-toolbar';
  toolbar.innerHTML =
    '<button type="button" class="mt-btn" data-act="zoomout" title="缩小">−</button>' +
    '<span class="mt-zoom">100%</span>' +
    '<button type="button" class="mt-btn" data-act="zoomin" title="放大">+</button>' +
    '<button type="button" class="mt-btn" data-act="reset" title="复位">⟲</button>' +
    '<button type="button" class="mt-btn mt-dl" data-act="download" title="下载 SVG（用浏览器打开查看）">⬇</button>';
  container.appendChild(toolbar);

  // 包裹 svg 为可变换的视口
  var viewport = document.createElement('div');
  viewport.className = 'mermaid-viewport';
  svg.parentNode.insertBefore(viewport, svg);
  viewport.appendChild(svg);

  var scale = 1, tx = 0, ty = 0;
  var MIN_S = 0.3, MAX_S = 3;

  function apply() {
    viewport.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
    var zp = toolbar.querySelector('.mt-zoom');
    if (zp) zp.textContent = Math.round(scale * 100) + '%';
  }
  function reset() { scale = 1; tx = 0; ty = 0; apply(); }

  // 工具栏按钮
  toolbar.addEventListener('click', function(e) {
    var btn = e.target.closest('.mt-btn');
    if (!btn) return;
    var act = btn.getAttribute('data-act');
    if (act === 'zoomin') { scale = Math.min(MAX_S, scale + 0.2); apply(); }
    else if (act === 'zoomout') { scale = Math.max(MIN_S, scale - 0.2); apply(); }
    else if (act === 'reset') { reset(); }
    else if (act === 'download') { _downloadMermaidSvg(svg, container.id || 'mermaid'); }
  });

  // 滚轮缩放（在容器内滚动 = 缩放，避免和页面滚动冲突用 preventDefault）
  container.addEventListener('wheel', function(e) {
    e.preventDefault();
    var delta = e.deltaY < 0 ? 0.1 : -0.1;
    scale = Math.max(MIN_S, Math.min(MAX_S, scale + delta));
    apply();
  }, { passive: false });

  // 拖拽平移
  var dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
  viewport.addEventListener('mousedown', function(e) {
    dragging = true; sx = e.clientX; sy = e.clientY; ox = tx; oy = ty;
    viewport.style.cursor = 'grabbing';
    e.preventDefault();
  });
  document.addEventListener('mousemove', function(e) {
    if (!dragging) return;
    tx = ox + (e.clientX - sx);
    ty = oy + (e.clientY - sy);
    apply();
  });
  document.addEventListener('mouseup', function() {
    if (dragging) { dragging = false; viewport.style.cursor = 'grab'; }
  });

  // 双击复位
  viewport.addEventListener('dblclick', reset);
  viewport.style.cursor = 'grab';
}

// 下载 mermaid 图为 SVG（加白底 rect，避免某些查看器显示成黑底）
function _downloadMermaidSvg(svg, name) {
  try {
    var clone = svg.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    // 显式补 width/height（mermaid SVG 可能只有 viewBox）
    var vb = clone.getAttribute('viewBox');
    var w = parseFloat(clone.getAttribute('width')) || (vb ? parseFloat(vb.split(/\s+/)[2]) : 800);
    var h = parseFloat(clone.getAttribute('height')) || (vb ? parseFloat(vb.split(/\s+/)[3]) : 600);
    clone.setAttribute('width', w);
    clone.setAttribute('height', h);
    // 在 svg 开头插入白底 rect（防 Windows 照片查看器显示黑底）
    var bgRect = '<rect width="' + w + '" height="' + h + '" fill="#ffffff"/>';
    var svgStr = new XMLSerializer().serializeToString(clone).replace(/(<svg[^>]*>)/, '$1' + bgRect);
    var blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
    _triggerDownload(blob, name + '.svg');
  } catch(e) {
    console.warn('[mermaid] 下载失败:', e);
  }
}


// _triggerDownload：触发浏览器下载
function _triggerDownload(blob, filename) {
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
}

// Issue2.1: mermaid 渲染失败 → 自动触发修复（最多 3 次，双位置提示）
function _triggerMermaidFix(container, failedCode, errorMsg, attempt) {
  if (!container) return;
  // 关键：用 ID 重新定位当前 DOM 里的容器（renderMessages 重建后旧引用可能脱离 DOM）
  var containerId = container.id;
  var liveContainer = containerId ? document.getElementById(containerId) : container;
  if (!liveContainer || !document.body.contains(liveContainer)) {
    // 容器已不在 DOM（被重建覆盖），停止修复
    _updateMermaidFixBanner();
    return;
  }
  container = liveContainer;
  attempt = attempt || 1;
  if (attempt > 3) {
    // 超过 3 次：显示失败兜底（确保容器永远有可见内容，不能空）
    container.setAttribute('data-fix-status', 'failed-final');
    container.innerHTML = '<div class="mermaid-fix-fail">⚠️ 图表语法复杂，AI 未能自动修复 ' +
      '<button type="button" class="mf-retry">再试一次</button>' +
      '<button type="button" class="mf-src">查看源码</button></div>';
    var retryBtn = container.querySelector('.mf-retry');
    var srcBtn = container.querySelector('.mf-src');
    if (retryBtn) retryBtn.onclick = function() {
      container.innerHTML = '<div class="mermaid-fixing"><span class="mf-dot"></span>AI 正在重新修复...</div>';
      container.setAttribute('data-fix-status', 'failed');
      _triggerMermaidFix(container, failedCode, errorMsg, 1);
    };
    if (srcBtn) srcBtn.onclick = function() {
      container.innerHTML = '<pre style="font-size:11px;white-space:pre-wrap;word-break:break-all;background:var(--bg-secondary);padding:10px;border-radius:6px;overflow:auto;max-height:200px">' + esc(failedCode) + '</pre>';
    };
    _updateMermaidFixBanner();
    return;
  }

  // 收集用户原始问题（取最近一条 user 消息文本）
  var originalQuestion = '';
  try {
    var userMsgs = document.querySelectorAll('.msg.user');
    if (userMsgs.length) {
      originalQuestion = (userMsgs[userMsgs.length - 1].textContent || '').replace(/\d{2}:\d{2}:\d{2}/, '').trim().slice(0, 500);
    }
  } catch(e) {}

  // 确定模型
  var model = '';
  try {
    var tag = document.getElementById('modelTag');
    if (tag) model = tag.getAttribute('data-model') || '';
  } catch(e) {}

  // 更新提示（图内 + 卡片底部）
  container.setAttribute('data-fix-attempt', attempt);
  _updateMermaidFixBanner();

  // SSE 调后端修复接口
  fetch((typeof API !== 'undefined' ? API : '') + '/api/chat/fix-mermaid', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      failed_code: failedCode,
      error_msg: errorMsg,
      original_question: originalQuestion,
      model: model,
      attempt: attempt
    })
  }).then(function(resp) {
    var reader = resp.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    var fixedCode = '';

    function pump() {
      reader.read().then(function(_ref) {
        var done = _ref.done, value = _ref.value;
        if (done) {
          _finishFix(containerId, failedCode, errorMsg, attempt, fixedCode);
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        var lines = buffer.split('\n');
        buffer = lines.pop();
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (line.indexOf('data: ') !== 0) continue;
          try {
            var evt = JSON.parse(line.slice(6));
            if (evt.type === 'text') {
              // 流式累计（不实时显示，修复完一次性渲染）
            } else if (evt.type === 'done') {
              fixedCode = evt.code || '';
            } else if (evt.type === 'error') {
              console.warn('[mermaid-fix] 接口错误:', evt.message);
            }
          } catch(e) {}
        }
        pump();
      }).catch(function(e) {
        console.warn('[mermaid-fix] 流读取失败:', e);
        _finishFix(containerId, failedCode, errorMsg, attempt, '');
      });
    }
    pump();
  }).catch(function(e) {
    console.warn('[mermaid-fix] 请求失败:', e);
    _finishFix(containerId, failedCode, errorMsg, attempt, '');
  });
}

function _finishFix(containerId, failedCode, errorMsg, attempt, fixedCode) {
  // 重新定位容器（可能被 renderMessages 重建）
  var container = document.getElementById(containerId);
  if (!container || !document.body.contains(container)) {
    _updateMermaidFixBanner();
    return;  // 容器不在了，停止
  }
  if (!fixedCode || !fixedCode.trim()) {
    // 修复无产出，重试
    _triggerMermaidFix(container, failedCode, errorMsg, attempt + 1);
    return;
  }
  // 用修复后的代码重新渲染
  try {
    var id = container.id || ('mermaid-' + Math.random().toString(36).slice(2, 10));
    mermaid.render(id, fixedCode).then(function(result) {
      // 渲染成功 → 替换
      container.removeAttribute('data-fix-status');
      container.removeAttribute('data-fix-attempt');
      container.setAttribute('data-mermaid', encodeURIComponent(fixedCode));
      container.innerHTML = result.svg;
      _enhanceMermaid(container, fixedCode);
      _updateMermaidFixBanner();
    }).catch(function(e) {
      // 修复后仍失败，重试（用新错误信息）
      _triggerMermaidFix(container, fixedCode, String(e.message || e).slice(0, 300), attempt + 1);
    });
  } catch(e) {
    _triggerMermaidFix(container, fixedCode, String(e).slice(0, 300), attempt + 1);
  }
}

// 更新卡片底部"自动修复中"提示条（汇总所有失败图）
function _updateMermaidFixBanner() {
  var failed = document.querySelectorAll('.mermaid-container[data-fix-status="failed"]');
  var banner = document.getElementById('mermaidFixBanner');
  if (!failed.length) {
    if (banner) banner.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'mermaidFixBanner';
    banner.className = 'mermaid-fix-banner';
    var messages = document.getElementById('messages');
    if (messages) messages.appendChild(banner);
  }
  var maxAttempt = 0;
  failed.forEach(function(c) {
    var a = parseInt(c.getAttribute('data-fix-attempt') || '1', 10);
    if (a > maxAttempt) maxAttempt = a;
  });
  // 参照 tokenBar 的 tag 胶囊风格
  banner.innerHTML = '<span class="mfb-icon">🔄</span>' +
    '<span class="mfb-tag">修复中</span>' +
    '<span>正在自动修复 ' + failed.length + ' 张图表（第 ' + maxAttempt + ' 次）</span>';
  banner.onclick = function() {
    if (failed.length) failed[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
}
window._triggerMermaidFix = _triggerMermaidFix;

// P6: HTML 预览——iframe 沙箱渲染
function _renderHtmlPreview(el) {
  if (!el) return;
  var containers = el.querySelectorAll('.html-preview-wrap:not([data-rendered])');
  containers.forEach(function(container) {
    var code = decodeURIComponent(container.getAttribute('data-html') || '');
    if (!code) return;
    container.setAttribute('data-rendered', '1');
    // 创建 iframe 沙箱
    var iframe = document.createElement('iframe');
    iframe.sandbox = 'allow-same-origin';
    iframe.style.cssText = 'width:100%;border:none;border-radius:6px;background:#fff';
    container.innerHTML = '';
    container.appendChild(iframe);
    // 自适应高度
    iframe.onload = function() {
      try {
        var h = iframe.contentWindow.document.body.scrollHeight;
        iframe.style.height = Math.min(h + 20, 600) + 'px';
      } catch(e) {
        iframe.style.height = '300px';
      }
    };
    // 写入 HTML（沙箱内无 JS 执行权限）
    var doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open();
    doc.write('<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:system-ui,sans-serif;padding:12px;color:#1F2937}*{box-sizing:border-box}</style></head><body>' + code + '</body></html>');
    doc.close();
  });
}
window._renderHtmlPreview = _renderHtmlPreview;

function md(text, sanitize) {
  if (!text) return '';
  // sanitize 默认 true（完整内容净化）；流式渲染时传 false 避免吃掉半截 HTML
  if (sanitize === undefined) sanitize = true;

  // Step 1: 提取 LaTeX 公式（用占位符保护，防止 marked 破坏 LaTeX 语法）
  var processed = _extractAndRenderLatex(text);
  var latexPlaceholders = processed.placeholders;
  text = processed.text;

  // Step 2: 配置 marked（如果可用）
  if (typeof marked === 'undefined') {
    return _mdFallback(text, latexPlaceholders);
  }

  // 自定义 renderer：代码块高亮 + 复制按钮
  var renderer = new marked.Renderer();
  renderer.code = function(obj) {
    // marked v15 传入对象 {text, lang, escaped}
    var code = (typeof obj === 'object' && obj.text !== undefined) ? obj.text : obj;
    var lang = (typeof obj === 'object' && obj.lang !== undefined) ? obj.lang : arguments[1];
    // P6: mermaid 代码块——渲染成 mermaid 容器（异步渲染由 _renderMermaid 处理）
    if (lang === 'mermaid') {
      var mermaidId = 'mermaid-' + Math.random().toString(36).slice(2, 10);
      var safeGraph = esc(code);
      // 存储到全局，供 _renderMermaid 异步渲染
      if (!window._mermaidQueue) window._mermaidQueue = {};
      window._mermaidQueue[mermaidId] = code;
      return '<div class="mermaid-container" id="' + mermaidId + '" data-mermaid="' + encodeURIComponent(code) + '"><div class="mermaid-loading">渲染图表中...</div></div>';
    }
    // P6: HTML 代码块——渲染成 iframe 沙箱预览（可折叠查看源码）
    if (lang === 'html') {
      var htmlId = 'html-preview-' + Math.random().toString(36).slice(2, 10);
      return '<div class="html-preview-wrap" id="' + htmlId + '" data-html="' + encodeURIComponent(code) + '"><div class="html-preview-loading">渲染中...</div></div>';
    }
    var cls = lang ? ' class="language-' + esc(lang) + '"' : '';
    // 先转义 HTML 特殊字符（防止 hljs 报 "unescaped HTML" 安全警告）
    var safeCode = esc(code);
    var highlighted = safeCode;
    if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
      try { highlighted = hljs.highlight(safeCode, {language: lang}).value; } catch(e) {}
    } else if (typeof hljs !== 'undefined') {
      try { highlighted = hljs.highlightAuto(safeCode).value; } catch(e) {}
    }
    // Patch5 C7: 纯净结构（header + 复制按钮由 CodeBlockEnhancer.enhance() 动态注入）
    return '<div class="code-block"><pre><code' + cls + '>' + highlighted + '</code></pre></div>';
  };

  // 自定义 heading：加 id 用于锚点
  renderer.heading = function(obj) {
    var hText = (typeof obj === 'object') ? obj.text : obj;
    var depth = (typeof obj === 'object') ? obj.depth : arguments[1];
    var slug = hText.replace(/<[^>]+>/g, '').replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
    return '<h' + depth + ' id="' + escAttr(slug) + '">' + hText + '</h' + depth + '>';
  };

  // 任务列表：marked v15 的 listitem 接收 tokens
  // 但 marked 已经内置了 checkbox 渲染，我们只加 class 即可
  // 由于 listitem API 在 v15 中不稳定，使用后处理替代

  // 配置 marked
  var options = {
    renderer: renderer,
    gfm: true,
    breaks: true,
    pedantic: false
  };

  // Step 3: 流式安全处理（未闭合的代码块）
  var hasUnclosedCode = text.match(/```/g) && (text.match(/```/g).length % 2 !== 0);
  if (hasUnclosedCode) {
    text = text + '\n```';
  }

  // Step 4: 使用 marked 渲染
  var html;
  try {
    html = marked.parse(text, options);
  } catch(e) {
    return _mdFallback(processed.text, latexPlaceholders);
  }

  // Step 5: 后处理

  // 5a: 任务列表样式增强（marked 已渲染 checkbox，加 class）
  html = html.replace(/<li><input (checked="" )?disabled="" type="checkbox">/g, function(m, checked) {
    var chkAttr = checked ? ' checked' : '';
    return '<li class="task-item"><input type="checkbox" class="task-checkbox" disabled' + chkAttr + '><span class="task-text">';
  });
  // 关闭 task-text span（在 task-item 的 </li> 前）
  html = html.replace(/(<li class="task-item">[\s\S]*?<span class="task-text">)([\s\S]*?)(<\/li>)/g, function(m, open, content, close) {
    return open + content + '</span>' + close;
  });

  // 5b: 脚注处理（marked v15 不原生支持 footnotes）
  html = _renderFootnotesFallback(html, text);

  // 5c: 表格样式优化（marked 可能不加 thead/tbody 的额外 class）
  // 已经有 .md table CSS 覆盖

  // Step 6: 恢复 LaTeX 占位符
  html = _restoreLatex(html, latexPlaceholders);

  // Step 7: 清理
  html = html.replace(/<\/?p>\s*<\/?p>/g, '');
  html = html.replace(/<h[1-6]><\/h[1-6]>/g, '');

  // Step 6: DOMPurify 净化（BUG-5：流式渲染也净化，防 XSS）
  // 原先 sanitize=false（流式）跳过净化，导致 <img onerror>/<svg onload> 等在流式窗口执行。
  // DOMPurify 对半截 HTML 是安全的；且最终/历史渲染用同一配置已验证可正确显示
  // 代码块/表格/LaTeX/mermaid/html 预览占位符等，流式启用不会改变显示结果。
  // sanitize 形参保留仅为向后兼容（现在恒净化）。
  if (typeof DOMPurify !== 'undefined') {
    html = DOMPurify.sanitize(html, {
      ADD_TAGS: ['details', 'summary', 'sup', 'foreignObject', 'span', 'path', 'rect', 'circle', 'line', 'text', 'g', 'svg', 'polyline', 'polygon', 'ellipse', 'defs', 'marker', 'use', 'tspan'],
      ADD_ATTR: ['target', 'class', 'id', 'data-mermaid', 'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'points', 'transform', 'viewBox', 'xmlns', 'xlink:href', 'href', 'font-size', 'font-family', 'font-weight', 'text-anchor', 'dominant-baseline', 'marker-end', 'marker-start', 'refX', 'refY', 'markerWidth', 'markerHeight', 'orient', 'overflow'],
      ALLOW_DATA_ATTR: true
    });
  }

  return html;
}

/**
 * 脚注后处理兜底（marked v15 不内置 footnotes）
 * marked 可能将 [^id] 原样保留，也可能将 [^id]: url 解析为链接引用
 * 情况1: HTML 中有 [^id] 文本 → 直接替换
 * 情况2: HTML 中有 <a href="...">^id</a> → 替换 <a> 标签
 */
function _renderFootnotesFallback(html, rawText) {
  if (html.indexOf('md-footnotes') !== -1) return html;

  // 从原始 markdown 中提取脚注定义
  var footnotes = [];
  var fnDefRegex = /^\[\^(\w+)\]:\s+(.+)$/gm;
  var m;
  while ((m = fnDefRegex.exec(rawText)) !== null) {
    footnotes.push({ id: m[1], text: m[2] });
  }

  if (footnotes.length === 0) return html;

  // 替换脚注引用为上标
  footnotes.forEach(function(fn) {
    // 情况1: marked 原样保留 [^id] 文本
    var literalRegex = new RegExp('\\[\\^' + escAttr(fn.id) + '\\]', 'g');
    if (literalRegex.test(html)) {
      html = html.replace(new RegExp('\\[\\^' + escAttr(fn.id) + '\\]', 'g'),
        '<sup class="fn-ref"><a href="#fn-' + escAttr(fn.id) + '">[' + esc(fn.id) + ']</a></sup>');
    } else {
      // 情况2: marked 将 [^id]: ... 解析为链接引用，渲染为 <a href="...">^id</a>
      html = html.replace(new RegExp('<a href="[^"]*">\\^' + escAttr(fn.id) + '<\\/a>', 'g'),
        '<sup class="fn-ref"><a href="#fn-' + escAttr(fn.id) + '">[' + esc(fn.id) + ']</a></sup>');
    }
  });

  // 移除脚注定义段落（marked 可能已消费掉，也可能渲染为 <p>[^id]: ...</p>）
  footnotes.forEach(function(fn) {
    html = html.replace(new RegExp('<p>\\[\\^' + escAttr(fn.id) + '\\]:\\s*[\\s\\S]*?<\\/p>', 'g'), '');
  });

  // 追加脚注列表
  var fnHtml = '<section class="md-footnotes"><hr><ol>';
  footnotes.forEach(function(fn) {
    fnHtml += '<li id="fn-' + escAttr(fn.id) + '">' + esc(fn.text) + ' <a href="#fnref-' + escAttr(fn.id) + '" class="fn-backref">&#8617;</a></li>';
  });
  fnHtml += '</ol></section>';

  return html + fnHtml;
}

/**
 * 基础 Markdown 回退渲染（marked 未加载时使用）
 * 保留原始正则逻辑作为降级方案
 */
function _mdFallback(text, latexPlaceholders) {
  // 代码块保护
  var codeBlocks = [];
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, function(_, lang, code) {
    var cls = lang ? 'language-' + lang : '';
    var idx = codeBlocks.length;
    codeBlocks.push('<div class="code-block"><pre><code class="' + cls + '">' + esc(code.trimEnd()) + '</code></pre></div>');
    return '\x02CB' + idx + '\x02';
  });
  text = text.replace(/```(\w*)\n([\s\S]*)$/g, function(_, lang, code) {
    var cls = lang ? 'language-' + lang : '';
    var idx = codeBlocks.length;
    codeBlocks.push('<div class="code-block"><pre><code class="' + cls + '">' + esc(code.trimEnd()) + '</code></pre></div>');
    return '\x02CB' + idx + '\x02';
  });
  text = text.replace(/```(\w*)$/gm, function(_, lang) {
    var cls = lang ? 'language-' + lang : '';
    var idx = codeBlocks.length;
    codeBlocks.push('<div class="code-block"><pre><code class="' + cls + '">');
    return '\x02CB' + idx + '\x02';
  });
  // 行内代码（用 esc() 防止代码内容中的 HTML 注入）
  text = text.replace(/`([^`\n]+)`/g, function(_, code) { return '<code>' + esc(code) + '</code>'; });
  // 粗体/斜体（用 esc() 防止注入）
  text = text.replace(/\*\*(.+?)\*\*/g, function(_, t) { return '<strong>' + esc(t) + '</strong>'; });
  text = text.replace(/\*(.+?)\*/g, function(_, t) { return '<em>' + esc(t) + '</em>'; });
  // 标题（用 esc() 防止注入）
  text = text.replace(/^### (.+)$/gm, function(_, t) { return '<h3>' + esc(t) + '</h3>'; });
  text = text.replace(/^## (.+)$/gm, function(_, t) { return '<h2>' + esc(t) + '</h2>'; });
  text = text.replace(/^# (.+)$/gm, function(_, t) { return '<h1>' + esc(t) + '</h1>'; });
  // 有序列表
  text = text.replace(/^\d+\. (.+)$/gm, function(_, t) { return '<li>' + esc(t) + '</li>'; });
  // 无序列表
  text = text.replace(/^[-*] (.+)$/gm, function(_, t) { return '<li>' + esc(t) + '</li>'; });
  // 合并连续 <li> 为 <ul>
  text = text.replace(/((?:<li>[\s\S]*?<\/li>\s*)+)/g, function(m) {
    return '<ul>' + m.replace(/<\/li>\s+<li>/g, '</li><li>') + '</ul>';
  });
  // 引用
  text = text.replace(/^> (.+)$/gm, function(_, t) { return '<blockquote>' + esc(t) + '</blockquote>'; });
  // 链接（过滤 javascript: 协议，用 esc() 转义）
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function(_, linkText, url) {
    var safeUrl = url.trim();
    if (/^javascript:/i.test(safeUrl)) safeUrl = '#blocked';
    return '<a href="' + esc(safeUrl) + '" target="_blank">' + esc(linkText) + '</a>';
  });
  // 段落分隔
  text = text.replace(/^[ \t]+$/gm, '');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/\n\n+/g, '</p><p>');
  text = text.replace(/\n/g, '<br>');
  // 清理
  text = text.replace(/<p>\s*<\/p>/g, '');
  text = text.replace(/<br>\s*<br>/g, '<br>');
  text = text.replace(/<br>\s*(<strong>)/g, '$1');
  text = text.replace(/(<\/strong>)\s*<br>\s*(<li>|<ul>)/g, '$1$2');
  // 恢复代码块占位符
  text = text.replace(/\x02CB(\d+)\x02/g, function(_, idx) {
    return codeBlocks[parseInt(idx)] || '';
  });
  // 恢复 LaTeX 占位符
  text = _restoreLatex(text, latexPlaceholders);
  var result = '<p>' + text + '</p>';
  return result === '<p></p>' ? '' : result;
}

/**
 * 渲染文件卡片 HTML
 * @param {object} file - 文件对象 { icon, filename, path, size_human, download_url }
 * @returns {string} HTML
 */
function renderFileCard(file) {
  return '<div class="file-card">' +
    '<span class="file-card-icon">' + (file.icon || iconSvg('doc','16')) + '</span>' +
    '<div class="file-card-info">' +
      '<div class="file-card-name" title="' + esc(file.filename || file.path || '') + '">' + esc(file.filename || file.path || '文件') + '</div>' +
      '<div class="file-card-size">' + esc(file.size_human || '') + '</div>' +
    '</div>' +
    '<div class="file-card-actions">' +
      '<button onclick="saveFileAs(\'' + esc(file.download_url || '') + '\', \'' + esc(file.filename || '') + '\')">' + iconSvg('file','12') + ' 另存为</button>' +
      '<button onclick="downloadFile(\'' + esc(file.download_url || '') + '\', \'' + esc(file.filename || '') + '\')">' + iconSvg('file','12') + ' 下载</button>' +
    '</div>' +
  '</div>';
}

/**
 * 渲染多个文件卡片
 * @param {Array} files - 文件数组
 * @returns {string} HTML
 */
function renderFileCards(files) {
  if (!files || !files.length) return '';
  return '<div class="file-card-list">' + files.map(function(f) { return renderFileCard(f); }).join('') + '</div>';
}

/**
 * 下载文件（直接下载）
 * @param {string} url - 下载 URL
 * @param {string} filename - 文件名
 */
function downloadFile(url, filename) {
  if (!url) return;
  var a = document.createElement('a');
  a.href = (typeof API !== 'undefined' ? API : '') + url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/**
 * 格式化统计行（不用 md，避免 code 标签干扰）
 */
function formatStats(model, chars, thinkChars, time, speed) {
  var s = '<div class="stats">';
  s += '<span>' + esc(model) + '</span> ';
  s += '<span>' + chars + '字</span> ';
  if (thinkChars > 0) s += '<span>深思' + thinkChars + '字</span> ';
  s += '<span>' + Number(time).toFixed(1) + 's</span> ';
  s += '<span>' + Math.round(speed) + '字/s</span>';
  s += '</div>';
  return s;
}

/**
 * 复制代码块内容到剪贴板
 * @param {HTMLButtonElement} btn - 复制按钮元素
 */
function copyCode(btn) {
  var block = btn.closest('.code-block');
  if (!block) return;
  var code = block.querySelector('code');
  if (!code) return;
  var text = code.textContent || '';
  // P5 C7：保留按钮内部结构（icon + 文本）
  var textEl = btn.querySelector('.code-copy-text');
  var _setBtnText = function(t) {
    if (textEl) textEl.textContent = t;
    else btn.textContent = t;
  };
  var _restoreBtn = function(orig) {
    return function() { _setBtnText(orig); };
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    var orig1 = textEl ? textEl.textContent : btn.textContent;
    navigator.clipboard.writeText(text).then(function() {
      _setBtnText('已复制');
      setTimeout(_restoreBtn(orig1), 1500);
    }).catch(function() {
      fallbackCopy(text, btn);
    });
  } else {
    fallbackCopy(text, btn);
  }
}

function fallbackCopy(text, btn) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    var textEl = btn.querySelector('.code-copy-text');
    var orig = textEl ? textEl.textContent : btn.textContent;
    if (textEl) textEl.textContent = '已复制';
    else btn.textContent = '已复制';
    setTimeout(function() {
      if (textEl) textEl.textContent = orig;
      else btn.textContent = orig;
    }, 1500);
  } catch(e) {}
  document.body.removeChild(ta);
}

/**
 * 创建 Blob 并触发下载
 * @param {string} content - 文件内容
 * @param {string} filename - 文件名
 * @param {string} mimeType - MIME 类型
 */
function downloadBlob(content, filename, mimeType) {
  var blob = new Blob([content], { type: mimeType || 'text/plain;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename || 'download';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function() { URL.revokeObjectURL(url); }, 3000);
}

// 暴露到全局
window.esc = esc;
window.escAttr = escAttr;
window.fmtMB = fmtMB;
window.autoResize = autoResize;
window.formatTime = formatTime;
window.showLoading = showLoading;
window.hideLoading = hideLoading;
window._renderLatex = _renderLatex;
window._extractAndRenderLatex = _extractAndRenderLatex;
window._restoreLatex = _restoreLatex;
window.md = md;
window.renderFileCard = renderFileCard;
window.renderFileCards = renderFileCards;
window.downloadFile = downloadFile;
window.formatStats = formatStats;
window.copyCode = copyCode;
window.downloadBlob = downloadBlob;
