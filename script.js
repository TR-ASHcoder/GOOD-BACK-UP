var coll = document.getElementsByClassName("collapsible");
var i;

for (i = 0; i < coll.length; i++) {
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
  var facts = ['Ver . 2.38 !', 'Fun fact: the logos name is choby!', 'UhhhhH','DONT SNITCH','PIRATE EVERYTHING','PLS USE THE SUGGEST FORM','YARRRRR','CATS <3','i use mint btw','all my homies use Good Threads','added new sites to....','Wine Is Not an Emulator'];
  var randomFact = Math.floor(Math.random() * facts.length);
  document.getElementById('announcementrand').innerHTML = facts[randomFact];
})();