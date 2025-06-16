chrome.runtime.onConnect.addListener(() => {
    console.log('The Kinopoisk Importer extension has launched');
});

chrome.tabs.query({ currentWindow: true, active: true }, function(tabs){
    console.log(tabs);
});