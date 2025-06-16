const downloadVotesBtn = document.getElementById('download-votes');
const downloadVotesLoadingBtn = document.getElementById('download-votes-loading');
const errorBlock = document.getElementById('error');
const userIdRow = document.getElementById('user_id_row');
const showUserIdRow = document.getElementById('show_user_id_row');
const userIdControl = document.getElementById('user_id');
const showUserIdControl = document.getElementById('show_user_id');
let useCustomUserId = false;

document.addEventListener('DOMContentLoaded', handleDOMLoaded);

showUserIdControl.addEventListener('change', handleChangeShowUserIdControl);
downloadVotesBtn.addEventListener('click', handleClickDownloadVotesBtn);

async function handleDOMLoaded() {
    let [tab] = await chrome.tabs.query({active: true, currentWindow: true});

    try {
        if (tab.url) {
            showMainContent();
        } else {
            showStub();
        }
    } catch (err) {
        showStub();
    }
}

function showMainContent() {
    document.getElementById('content').style.display = '';
}

function showStub() {
    document.getElementById('stub').style.display = '';
}

function handleChangeShowUserIdControl (event) {
    event.preventDefault();

    errorHide();

    if (showUserIdControl.checked) {
        customUserIdShow();
    } else {
        customUserIdHide();
    }
}

async function handleClickDownloadVotesBtn() {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});

    if (useCustomUserId && !userIdControl.value) {
        errorShow('Please enter a User ID');
        return;
    }

    downloadButtonDisable();
    errorHide();

    try {
        const customUserId = useCustomUserId ? userIdControl.value : '';
        const scriptExecuted = await chrome.scripting.executeScript({
            target: {tabId: tab.id},
            function: collectAndDownloadMyRatings,
            args: [customUserId],
        });

        downloadButtonEnable();

        const result = scriptExecuted?.[0]?.result || {};

        const {
            rows = ['', '', '', ''],
            error,
        } = result;

        if (error) {
            errorShow(error);
            return;
        }

        // Add the "title" row
        rows.unshift(['name_rus', 'name_eng', 'rating', 'date']);

        const csvContent = "data:text/csv;charset=utf-8,"
            + rows.map((row) => {
                return row.map(processTheCell).join(",");
            }).join("\n");
        const encodedUri = encodeURI(csvContent);
        window.open(encodedUri);
    } catch (err) {
        errorShow(err.message || 'Unknown error');
    }

    /**
     * process all the unsafe symbols in the CSV cell value
     * @param {String} str
     * @return {String}
     */
    function processTheCell(str) {
        try {
            return `"${str.replaceAll('"', '""')}"`;
        } catch (err) {
            throw new Error(`Can not parse this: ${safeJsonStringify(str)}`);
        }
    }

    /**
     * Safe JSON stringify
     * @param {String} str
     * @return {String}
     */
    function safeJsonStringify(str) {
        try {
            return JSON.stringify(str);
        } catch (err) {
            return String(str);
        }
    }
}

/**
 * collects all the ratings
 * The body of this function will be executed as a content script inside the
 * current page
 * @param {String} customUserId
 * @return {Promise<Array<[String, String, String]>>}
 */
function collectAndDownloadMyRatings(customUserId) {
    let totalPages = null;
    const userId = getUserId();

    if (!isValidUserId(userId)) {
        return Promise.resolve({ error: 'Unable to find the user' });
    }
    
    return new Promise(async (resolve) => {
        try {
            // Сначала загружаем первую страницу, чтобы узнать общее количество страниц
            const firstPageData = await loadAjax(userId, 1);
            if (!firstPageData || !Array.isArray(firstPageData.rows)) {
                resolve({ error: 'Failed to load the first page' });
                return;
            }
            //console.log('[DEBUG] First page loaded. Entries:', firstPageData.rows.length);

            const totalPages = firstPageData.totalPages || 1;
            console.log(`[DEBUG] Total pages to download! ${totalPages}`);

            // Если всего 1 страница, возвращаем её данные
            if (totalPages === 1) {
                resolve({ rows: firstPageData.rows });
                return;
            }

            // Создаем массив промисов для загрузки всех страниц
            const pagePromises = [];
            for (let page = 2; page <= totalPages; page++) {
            	//console.log(`[DEBUG] Adding a page to the queue: ${page}`);
                pagePromises.push(loadAjax(userId, page));
            }

            // Загружаем все страницы параллельно
            const allPagesData = await Promise.all(pagePromises);
            //console.log(`[DEBUG] All pages are loaded. Number of pages: ${allPagesData.length}`);
            
            // Собираем все строки вместе
            const allRows = firstPageData.rows.concat(...allPagesData.map(page => page.rows));
            console.log(`[DEBUG] Total records downloaded: ${allRows.length}`);

            resolve({ rows: allRows });
        } catch (err) {
            resolve({ error: err.message || 'Error during data loading' });
        }
    });
    
    /**
     * is a user_id we have valid
     * @param {String} userId
     */
    function isValidUserId(userId) {
        const userIdStr = String(userId);

        return /^\d+$/.test(userIdStr);
    }

    /**
     * loads the data from a page
     * @param {String} userId
     * @param {Number} pageId
     * @return {Promise<string[][]>}
     */
    function loadAjax(userId, pageId = 1) {
        const votesUrl = `https://www.kinopoisk.ru/user/${userId}/votes/list/ord/date/page/${pageId}/`;

        return fetch(votesUrl)
        .then((res) => res.text())
        .then((txt) => {
            const htmlEl = document.createElement('html');
            htmlEl.innerHTML = txt;

            const list = htmlEl.querySelector('.profileFilmsList');
            if (!list) {
                throw new Error('The element .profileFilmsList was not found');
            }

            const items = list.querySelectorAll('.item');
            const itemsArr = [];
            
            items.forEach((item) => {
                const nameRus = item.querySelector('.nameRus')?.innerText || '';
                const nameEng = (item.querySelector('.nameEng')?.innerText || '').replace(/#/g, '№');
                //console.log(`[DEBUG] nameRus: ${nameRus}, nameEng: ${nameEng}`);
                
                const date = item.querySelector('.date')?.innerText.trim() || '';
                let rating = '';

                if (customUserId) {
                    rating = item.querySelector('.vote')?.innerText || '';
                } else {
                    const scriptElLast = item.querySelectorAll('script')?.[1];
                    const scriptText = scriptElLast?.innerText || '';
                    rating = scriptText.match(/rating: '(\d+)/)?.[1] || '';
                }
                
                itemsArr.push([nameRus, nameEng, rating, date]);
            });

            // Получаем общее количество страниц только для первой страницы
            let totalPages = 1;
            if (pageId === 1) {
                const totalRatings = getTotalRatingsNumber(htmlEl);
                if (totalRatings) {
                    totalPages = Math.ceil(totalRatings / 50); // 50 записей на странице
                }
            }

            return { rows: itemsArr, totalPages };
        });
    }

    /**
     * get total number of films you have rated
     * @param {HTMLElement} html
     * @return {Number|null} total
     */
    function getTotalRatingsNumber(html) {
        const totalRatingsSelector = '.pagesFromTo';
        const totalRatingsEl = html.querySelector(totalRatingsSelector);
        const totalRatingText = totalRatingsEl?.innerText || '';
        const substrings = totalRatingText.split(/\s/) || [];
        return substrings[substrings.length - 1] || null;
    }

    /**
     * get user id
     * @return {String} userId
     */
    function getUserId() {
        if (customUserId) return customUserId;

        const userIdLink = Array.prototype.find.call(document.links, (link) => link.href.match(/\/user\/\d+\/go\//));
        const userIdLinkHref = userIdLink?.getAttribute?.('href') || '';
        return userIdLinkHref.match(/(\d+)/)?.[1] || '';
    }

    /**
     * get total pages to parse from
     * @param {Number|null} totalRatings
     */
    function getPagesCount(totalRatings) {
        if (!totalRatings) return 1;

        const rowsPerPage = 50;
        return Math.ceil(totalRatings / rowsPerPage);
    }
}

function downloadButtonDisable() {
    downloadVotesBtn.style.display = 'none';
    downloadVotesLoadingBtn.style.display = '';
}

function downloadButtonEnable() {
    downloadVotesBtn.style.display = '';
    downloadVotesLoadingBtn.style.display = 'none';
}

function errorHide() {
    errorBlock.style.display = 'none';
    errorBlock.innerHTML = '';
}

function errorShow(errorMessage) {
    errorBlock.style.display = '';
    errorBlock.innerHTML = errorMessage;

    downloadButtonEnable();
}

function customUserIdHide() {
    userIdRow.style.display = 'none';
    useCustomUserId = false;
    userIdControl.value = '';
}

function customUserIdShow() {
    userIdRow.style.display = '';
    useCustomUserId = true;
    userIdControl.value = '';
}