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
  var facts = ['Ver . 2.34... technically', 'MEOWWWWWWW', 'UhhhhH','VISIT THE MAIN SITE','DONT SNITCH','THANK YOU @KTEHLLAMA','PLS USE THE SUGGEST FORM','YARRRRR','CATS <3','i still remember 15/2/24','all my homies use Good Threads','added new sites to....'];
  var randomFact = Math.floor(Math.random() * facts.length);
  document.getElementById('announcementrand').innerHTML = facts[randomFact];
})();

