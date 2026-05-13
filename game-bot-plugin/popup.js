// Open the game tab when the link is clicked (works in MV3 popup context)
document.getElementById("open").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: "https://www.icemancountdown.com/runner" });
});
