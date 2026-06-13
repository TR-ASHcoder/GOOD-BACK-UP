var coll = document.getElementsByClassName("collapsible");
var i;

for (i = 0; i < coll.length; i++) {
  var caret = document.createElement("span");
  caret.className = "caret";
  caret.textContent = "▶";
  coll[i].insertBefore(caret, coll[i].firstChild);

  coll[i].addEventListener("click", function() {
    this.classList.toggle("active");
    var content = this.nextElementSibling;
    if (content.style.display === "block") {
      content.style.display = "none";
    } else {
      content.style.display = "block";
    }
  });
}

(function newFact() {
  var facts = ['Ver . 3.43 !?!', 'Fun fact: the logos name is choby!', 'As-salamu alaykum !','DONT SNITCH','PIRATE EVERYTHING','PLS USE THE SUGGEST FORM','death to Crunchyroll','CATS <3','went back to mint','all my homies use Good Threads','added new sites to....','sometimes..','whats 9+10?'];
  var randomFact = Math.floor(Math.random() * facts.length);
  document.getElementById('announcementrand').innerHTML = facts[randomFact];
})();