// Rack view interactions
document.addEventListener('DOMContentLoaded', function() {
  // Highlight all slots belonging to same asset on hover
  var assetEls = document.querySelectorAll('.slot-row[data-asset-id], .blade-half[data-asset-id]');
  assetEls.forEach(function(el) {
    el.addEventListener('mouseenter', function() {
      var assetId = this.dataset.assetId;
      if (!assetId) return;
      document.querySelectorAll('[data-asset-id="' + assetId + '"]').forEach(function(u) {
        u.style.filter = 'brightness(1.1)';
      });
    });
    el.addEventListener('mouseleave', function() {
      var assetId = this.dataset.assetId;
      if (!assetId) return;
      document.querySelectorAll('[data-asset-id="' + assetId + '"]').forEach(function(u) {
        u.style.filter = '';
      });
    });
  });
});
